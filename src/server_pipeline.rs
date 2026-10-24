use super::*;
use std::collections::BTreeMap;

struct Reply {
    channel: oneshot::Sender<Result<Position, Failure>>,
    result: Result<Position, Failure>,
    _admission: OwnedSemaphorePermit,
}
struct Batch {
    prepared: Option<timeline::Prepared>,
    prefix: timeline::Prefix,
    replies: Vec<Reply>,
    _permit: OwnedSemaphorePermit,
}
impl Batch {
    fn finish(self, published: bool) {
        for reply in self.replies {
            let result = if published {
                reply.result
            } else {
                Err(stopped())
            };
            let _ = reply.channel.send(result);
        }
    }
}
enum Publication {
    Batch(Batch),
    Barrier(oneshot::Sender<Result<timeline::Prefix>>),
    Refresh(
        timeline::Prefix,
        Option<timeline::Snapshot>,
        oneshot::Sender<Result<timeline::Prefix>>,
    ),
}
impl Publication {
    fn reject(self) {
        match self {
            Self::Batch(batch) => batch.finish(false),
            Self::Barrier(reply) | Self::Refresh(_, _, reply) => {
                let _ = reply.send(Err(anyhow::anyhow!("publication stopped")));
            }
        }
    }
}

#[derive(Clone)]
struct Stop {
    signal: watch::Sender<bool>,
    batches: Arc<Semaphore>,
}
impl Stop {
    fn stop(&self) {
        self.signal.send_replace(true);
        self.batches.close();
    }
}
impl Drop for Stop {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn publish(
    bucket: Box<Bucket>,
    mut queue: mpsc::Receiver<Publication>,
    published: watch::Sender<timeline::Prefix>,
    stop: Stop,
    mut halted: watch::Receiver<bool>,
    backups: Option<watch::Sender<Option<timeline::Snapshot>>>,
) -> Result<()> {
    let mut prefix = published.borrow().clone();
    let result = async {
        loop {
            let message = tokio::select! {
                biased;
                _ = halted.changed() => bail!("preparation stopped"),
                message = queue.recv() => message,
            };
            let Some(message) = message else { return Ok(()); };
            if *halted.borrow() {
                message.reject();
                bail!("preparation stopped");
            }
            match message {
                Publication::Batch(mut batch) => {
                    let snapshot = batch.prepared.as_ref().and_then(|p| p.snapshot());
                    let next = match batch.prepared.take() {
                        Some(prepared) => match prepared.publish(&bucket, &prefix).await {
                            Ok(next) => next,
                            Err(error) => {
                                batch.finish(false);
                                return Err(error);
                            }
                        },
                        None => prefix.clone(),
                    };
                    anyhow::ensure!(next == batch.prefix, "prepared batch prefix mismatch");
                    let advanced = next != prefix;
                    prefix = next;
                    published.send_replace(prefix.clone());
                    if let (Some(backups), Some(snapshot)) = (&backups, snapshot) {
                        backups.send_replace(Some(snapshot));
                    }
                    if advanced {
                        tracing::info!(milestone=%prefix.milestone(), requests=batch.replies.iter().filter(|r|r.result.is_ok()).count(), "put of success");
                    }
                    batch.finish(true);
                }
                Publication::Barrier(reply) => {
                    let _ = reply.send(Ok(prefix.clone()));
                }
                Publication::Refresh(next, snapshot, reply) => {
                    anyhow::ensure!(next.milestone() >= prefix.milestone() && (next.milestone() != prefix.milestone() || next == prefix), "refreshed prefix disagrees with publication");
                    prefix = next;
                    published.send_replace(prefix.clone());
                    if let (Some(backups), Some(snapshot)) = (&backups, snapshot) {
                        backups.send_replace(Some(snapshot));
                    }
                    let _ = reply.send(Ok(prefix.clone()));
                }
            }
        }
    }.await;
    if let Err(error) = &result {
        tracing::error!(%error, "publication stopped");
        stop.stop();
        queue.close();
        while let Ok(message) = queue.try_recv() {
            message.reject();
        }
    }
    result
}

struct Preparation {
    bucket: Box<Bucket>,
    stager: Option<timeline::Stager>,
    output: mpsc::Sender<Publication>,
    published: watch::Receiver<timeline::Prefix>,
    halted: watch::Receiver<bool>,
    batches: Arc<Semaphore>,
    batch_max: usize,
    batch_wait: Duration,
}
impl Preparation {
    async fn next(&mut self, queue: &mut mpsc::Receiver<Message>) -> Result<Option<Message>> {
        anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
        tokio::select! {
            biased;
            _ = self.halted.changed() => bail!("publication stopped"),
            message = queue.recv() => Ok(message),
        }
    }
    async fn refreshed(&mut self) -> Result<timeline::Basin> {
        let (reply, complete) = oneshot::channel();
        self.output
            .send(Publication::Barrier(reply))
            .await
            .map_err(|_| anyhow::anyhow!("publication stopped"))?;
        let prefix = complete.await.context("publication barrier stopped")??;
        let mut basin = self
            .stager
            .take()
            .context("missing preparation state")?
            .into_settled(&prefix)?;
        timeline::refresh(&self.bucket, &mut basin).await?;
        let (reply, complete) = oneshot::channel();
        let snapshot = basin.snapshot()?;
        self.output
            .send(Publication::Refresh(basin.prefix(), snapshot, reply))
            .await
            .map_err(|_| anyhow::anyhow!("publication stopped"))?;
        anyhow::ensure!(
            complete.await.context("publication refresh stopped")?? == basin.prefix(),
            "refresh acknowledgement mismatch"
        );
        Ok(basin)
    }
    async fn run(&mut self, queue: &mut mpsc::Receiver<Message>) -> Result<()> {
        let mut pending = None;
        loop {
            anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
            let message = match pending.take() {
                Some(message) => Some(message),
                None => self.next(queue).await?,
            };
            let Some(message) = message else {
                return Ok(());
            };
            match message {
                Message::Status { flow, reply } => {
                    let recent = match basinsync::epilogue::latest_key(
                        &self.bucket,
                        &basinsync::epilogue::flow_prefix(&flow),
                    )
                    .await?
                    {
                        Some((key, viewpoint)) => Some(RecentMarker {
                            viewpoint,
                            url: self.bucket.presign_get(key, 300, None).await?,
                        }),
                        None => None,
                    };
                    let basin = self.refreshed().await?;
                    let latest = basin.latest(&flow)?.map(|viewpoint| Position { viewpoint });
                    self.stager = Some(basin.into_stager());
                    let _ = reply.send(Ok(EpilogueStatus { latest, recent }));
                }
                Message::Commit(first) => {
                    let permit = self
                        .batches
                        .clone()
                        .acquire_owned()
                        .await
                        .context("publication stopped")?;
                    let mut size = first.size();
                    let mut batch = vec![first];
                    let deadline = tokio::time::Instant::now() + self.batch_wait;
                    while batch.len() < self.batch_max {
                        anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
                        let message = match queue.try_recv() {
                            Ok(message) => Some(message),
                            Err(mpsc::error::TryRecvError::Disconnected) => None,
                            Err(mpsc::error::TryRecvError::Empty) => {
                                tokio::time::timeout_at(deadline, self.next(queue))
                                    .await
                                    .unwrap_or(Ok(None))?
                            }
                        };
                        match message {
                            Some(Message::Commit(c)) if size + c.size() <= MAX_BODY => {
                                size += c.size();
                                batch.push(c);
                            }
                            Some(message) => {
                                pending = Some(message);
                                break;
                            }
                            None => break,
                        }
                    }
                    let settled =
                        self.stager.as_ref().unwrap().prefix() == *self.published.borrow();
                    if settled {
                        let basin = self.refreshed().await?;
                        self.stager = Some(basin.into_stager());
                    }
                    let stager = self.stager.take().context("missing preparation state")?;
                    let (stager, batch) =
                        tokio::task::spawn_blocking(move || prepare(stager, batch, permit))
                            .await
                            .context("preparation task panicked")??;
                    self.stager = Some(stager);
                    anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
                    self.output
                        .send(Publication::Batch(batch))
                        .await
                        .map_err(|_| anyhow::anyhow!("publication stopped"))?;
                }
            }
        }
    }
}

fn prepare(
    mut stager: timeline::Stager,
    requests: Vec<QueuedCommit>,
    permit: OwnedSemaphorePermit,
) -> Result<(timeline::Stager, Batch)> {
    let mut expected = BTreeMap::<String, Viewpoint>::new();
    let mut commands = Vec::new();
    let mut replies = Vec::new();
    for queued in requests {
        let Commit {
            flow,
            marker,
            viewpoint,
        } = queued.request;
        let next = match expected.get(&flow) {
            Some(next) => next.clone(),
            None => stager.expected(&flow)?,
        };
        let result = if viewpoint != next {
            Err(Failure::Mismatch(ViewpointMismatch {
                next: Position { viewpoint: next },
            }))
        } else {
            expected.insert(flow.clone(), viewpoint.next());
            commands.push(event::FlowCommand {
                markers: BTreeMap::from([(flow, marker)]),
            });
            Ok(Position { viewpoint })
        };
        replies.push(Reply {
            channel: queued.reply,
            result,
            _admission: queued.admission,
        });
    }
    let prepared = if commands.is_empty() {
        None
    } else {
        Some(stager.prepare(commands)?)
    };
    let prefix = stager.prefix();
    if prepared.is_some() {
        tracing::debug!(milestone=%prefix.milestone(), "batch prepared");
    } else {
        tracing::debug!(milestone=%prefix.milestone(), "batch rejected");
    }
    Ok((
        stager,
        Batch {
            prepared,
            prefix,
            replies,
            _permit: permit,
        },
    ))
}

impl Worker {
    pub(super) async fn run(mut self, mut queue: mpsc::Receiver<Message>) -> Result<()> {
        self.state.enable_vfs()?;
        let backups = if self.backup_interval.is_zero() {
            None
        } else {
            let (targets, receiver) = watch::channel(self.state.snapshot()?);
            tokio::spawn(basinsync::backup::run(
                self.bucket.clone(),
                receiver,
                self.backup_interval,
            ));
            Some(targets)
        };
        let (output, receiver) = mpsc::channel(PIPELINE_BATCHES - 1);
        let (published, published_rx) = watch::channel(self.state.prefix());
        let (signal, halted) = watch::channel(false);
        let batches = Arc::new(Semaphore::new(PIPELINE_BATCHES));
        let stop = Stop {
            signal,
            batches: batches.clone(),
        };
        let publisher = tokio::spawn(publish(
            self.bucket.clone(),
            receiver,
            published,
            stop.clone(),
            halted.clone(),
            backups,
        ));
        let mut preparation = Preparation {
            bucket: self.bucket,
            stager: Some(self.state.into_stager()),
            output,
            published: published_rx,
            halted,
            batches,
            batch_max: self.batch_max,
            batch_wait: self.batch_wait,
        };
        let result = preparation.run(&mut queue).await;
        if let Err(error) = &result {
            tracing::error!(%error, "preparation stopped");
            stop.stop();
            queue.close();
            while let Ok(message) = queue.try_recv() {
                message.reject();
            }
        }
        drop(preparation);
        let publication = publisher.await.context("publication task panicked")?;
        result.and(publication)
    }
}

use super::*;
use std::collections::BTreeMap;
fn submission_outcome<T>(
    result: &std::result::Result<T, Failure>,
    published: bool,
) -> &'static str {
    if !published {
        return "failed";
    }
    match result {
        Ok(_) => "ok",
        Err(Failure::Error(status, _)) if status.is_server_error() => "failed",
        Err(_) => "rejected",
    }
}

struct CommitReply {
    trace: obs::Submission,
    channel: oneshot::Sender<ApiReply<Position>>,
    result: Result<Position, Failure>,
    _admission: OwnedSemaphorePermit,
}
enum Reply {
    Kernel {
        channel: oneshot::Sender<Result<Viewpoint>>,
        viewpoint: Viewpoint,
    },
    Cleanup(oneshot::Sender<Result<()>>),
    Commit(CommitReply),
    Reserve {
        trace: obs::Submission,
        channel: oneshot::Sender<ApiReply<heap::Outcome>>,
        result: Result<heap::Outcome, Failure>,
        _admission: OwnedSemaphorePermit,
    },
}
struct Batch {
    trace: obs::BatchTrace,
    prepared: Option<timeline::Prepared>,
    prefix: timeline::Prefix,
    replies: Vec<Reply>,
    _permit: OwnedSemaphorePermit,
}
impl Batch {
    fn finish(mut self, published: bool, prefix: &timeline::Prefix) {
        self.trace.finish(published);
        for reply in self.replies {
            match reply {
                Reply::Kernel { channel, viewpoint } => {
                    let _ = channel.send(if published {
                        Ok(viewpoint)
                    } else {
                        Err(anyhow::anyhow!("publication stopped"))
                    });
                }
                Reply::Cleanup(reply) => {
                    let _ = reply.send(if published {
                        Ok(())
                    } else {
                        Err(anyhow::anyhow!("publication stopped"))
                    });
                }
                Reply::Commit(reply) => {
                    let result = if published {
                        reply.result
                    } else {
                        Err(stopped())
                    };
                    reply.trace.finish(
                        submission_outcome(&result, published),
                        prefix.milestone(),
                        !reply.channel.is_closed(),
                    );
                    let _ = reply.channel.send(observed(result, prefix));
                }
                Reply::Reserve {
                    trace,
                    channel,
                    result,
                    _admission,
                } => {
                    let result = if published { result } else { Err(stopped()) };
                    trace.finish(
                        submission_outcome(&result, published),
                        prefix.milestone(),
                        !channel.is_closed(),
                    );
                    let _ = channel.send(observed(result, prefix));
                }
            }
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
    fn reject(self, prefix: &timeline::Prefix) {
        match self {
            Self::Batch(batch) => batch.finish(false, prefix),
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
    orders: Option<mpsc::Sender<basinsync::analogue::DurableEvent>>,
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
                message.reject(&prefix);
                bail!("preparation stopped");
            }
            match message {
                Publication::Batch(mut batch) => {
                    let span=batch.trace.span.clone();
                    async {
                    batch.trace.publishing();
                    let snapshot = batch.prepared.as_ref().and_then(|p| p.snapshot());
                    let next = match batch.prepared.take() {
                        Some(prepared) => match obs::measured("publish", "timeline", prepared.publish_with_bytes(&bucket, &prefix)).await {
                            Ok((next, bytes)) => {
                                if let Some(orders) = &orders {
                                    let _ = orders.try_send(basinsync::analogue::DurableEvent { milestone: next.milestone().clone(), bytes });
                                }
                                next
                            },
                            Err(error) => {
                                batch.finish(false, &prefix);
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
                        metrics::gauge!("basinsync_last_success_timestamp_seconds", "operation"=>"timeline").set(time::OffsetDateTime::now_utc().unix_timestamp() as f64);
                        tracing::info!(milestone=%prefix.milestone(), requests=batch.replies.iter().filter(|r|matches!(r,Reply::Commit(CommitReply {result:Ok(_),..})|Reply::Reserve {result:Ok(_),..})).count(), "put of success");
                    }
                    batch.finish(true, &prefix);
                    Ok::<_, anyhow::Error>(())
                    }.instrument(span).await?;
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
            message.reject(&prefix);
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
    shutdown: watch::Receiver<bool>,
    draining: bool,
    batches: Arc<Semaphore>,
    batch_max: usize,
    batch_wait: Duration,
    status_probe_max_age: Duration,
    last_probe: Option<tokio::time::Instant>,
}
impl Preparation {
    async fn next(&mut self, queue: &mut mpsc::Receiver<Message>) -> Result<Option<Message>> {
        anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
        loop {
            tokio::select! {
                biased;
                _ = self.halted.changed() => bail!("publication stopped"),
                _ = self.shutdown.changed(), if !self.draining => {
                    self.draining = true;
                    queue.close();
                },
                message = queue.recv() => return Ok(message),
            }
        }
    }
    async fn refreshed(&mut self, before_write: bool) -> Result<timeline::Basin> {
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
        // Count freshness from before the IO, so a slow probe cannot extend it.
        let started = tokio::time::Instant::now();
        // Writes always probe; status reuses a fresh probe.
        if before_write
            || self
                .last_probe
                .is_none_or(|last| started.duration_since(last) >= self.status_probe_max_age)
        {
            timeline::refresh_if_advanced(&self.bucket, &mut basin).await?;
            self.last_probe = Some(started);
        }
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
    async fn write_stager(&mut self) -> Result<timeline::Stager> {
        let settled = self
            .stager
            .as_ref()
            .context("missing preparation state")?
            .prefix()
            == *self.published.borrow();
        if settled {
            let basin = self.refreshed(true).await?;
            self.stager = Some(basin.into_stager());
        }
        self.stager.take().context("missing preparation state")
    }
    async fn run(&mut self, queue: &mut mpsc::Receiver<Message>) -> Result<()> {
        let mut pending = None;
        loop {
            anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
            if *self.shutdown.borrow() && !self.draining {
                self.draining = true;
                queue.close();
            }
            let message = match pending.take() {
                Some(message) => Some(message),
                None => self.next(queue).await?,
            };
            let Some(message) = message else {
                return Ok(());
            };
            let span = match &message {
                Message::Commit(c) => c.trace.span.clone(),
                Message::Reserve(r) => r.trace.span.clone(),
                Message::Status { span, .. } => span.clone(),
                Message::Kernel(request) => request.span.clone(),
                _ => tracing::Span::none(),
            };
            async {
                match message {
                    Message::BackupBarrier(reply) => {
                        let (barrier, complete) = oneshot::channel();
                        self.output
                            .send(Publication::Barrier(barrier))
                            .await
                            .map_err(|_| anyhow::anyhow!("publication stopped"))?;
                        let result = complete
                            .await
                            .context("backup barrier stopped")
                            .and_then(|r| r)
                            .map(|_| ());
                        let _ = reply.send(result);
                    }
                    Message::Kernel(request) => {
                        let permit = self
                            .batches
                            .clone()
                            .acquire_owned()
                            .await
                            .context("publication stopped")?;
                        let mut stager = self.write_stager().await?;
                        let (stager, batch) = tokio::task::spawn_blocking(move || {
                            let mut trace = obs::BatchTrace::new("kernel");
                            trace.span.follows_from(request.span.id());
                            let _entered = trace.span.clone().entered();
                            match stager.prepare_kernel(request.operation) {
                                Ok((prepared, viewpoint)) => {
                                    trace.prepared(stager.prefix().milestone());
                                    let batch = Batch {
                                        trace,
                                        prefix: stager.prefix(),
                                        prepared: Some(prepared),
                                        replies: vec![Reply::Kernel {
                                            channel: request.reply,
                                            viewpoint,
                                        }],
                                        _permit: permit,
                                    };
                                    Ok((stager, Some(batch)))
                                }
                                Err(error) => {
                                    trace.finish(false);
                                    let _ = request.reply.send(Err(error));
                                    anyhow::ensure!(
                                        !stager.poisoned(),
                                        "database group restoration failed"
                                    );
                                    Ok((stager, None))
                                }
                            }
                        })
                        .await
                        .context("kernel preparation panicked")??;
                        self.stager = Some(stager);
                        if let Some(batch) = batch {
                            self.output
                                .send(Publication::Batch(batch))
                                .await
                                .map_err(|_| anyhow::anyhow!("publication stopped"))?;
                        }
                    }
                    Message::InspectCommit { mut request, reply } => {
                        let mut stager = self.write_stager().await?;
                        let (stager, request) = tokio::task::spawn_blocking(move || {
                            stager.inspect_children(&request.marker.edges, &mut request.proofs)?;
                            Ok::<_, anyhow::Error>((stager, request))
                        })
                        .await
                        .context("marker inspection panicked")??;
                        self.stager = Some(stager);
                        let _ = reply.send(Ok(request));
                    }
                    Message::Promote { command, reply } => {
                        let permit = self
                            .batches
                            .clone()
                            .acquire_owned()
                            .await
                            .context("publication stopped")?;
                        let mut stager = self.write_stager().await?;
                        let (stager, batch) = tokio::task::spawn_blocking(move || {
                            let trace = obs::BatchTrace::new("promotion");
                            let _entered = trace.span.clone().entered();
                            let result = stager.prepare_promotion(command);
                            maintenance_batch(stager, result, reply, permit, trace)
                        })
                        .await
                        .context("promotion preparation panicked")??;
                        self.stager = Some(stager);
                        self.output
                            .send(Publication::Batch(batch))
                            .await
                            .map_err(|_| anyhow::anyhow!("publication stopped"))?;
                    }
                    Message::InspectHeap { mut request, reply } => {
                        let mut stager = self.write_stager().await?;
                        let (stager, request) = tokio::task::spawn_blocking(move || {
                            stager.inspect_heap(&mut request)?;
                            Ok::<_, anyhow::Error>((stager, request))
                        })
                        .await
                        .context("heap inspection panicked")??;
                        self.stager = Some(stager);
                        let _ = reply.send(Ok(request));
                    }
                    Message::Cleanup { command, reply } => {
                        let permit = self
                            .batches
                            .clone()
                            .acquire_owned()
                            .await
                            .context("publication stopped")?;
                        let mut stager = self.write_stager().await?;
                        let (stager, batch) = tokio::task::spawn_blocking(move || {
                            let trace = obs::BatchTrace::new("cleanup");
                            let _entered = trace.span.clone().entered();
                            let result = stager.prepare_cleanup(command);
                            maintenance_batch(stager, result, reply, permit, trace)
                        })
                        .await
                        .context("cleanup preparation panicked")??;
                        self.stager = Some(stager);
                        self.output
                            .send(Publication::Batch(batch))
                            .await
                            .map_err(|_| anyhow::anyhow!("publication stopped"))?;
                    }
                    Message::Reserve(reservation) => {
                        let permit = self
                            .batches
                            .clone()
                            .acquire_owned()
                            .await
                            .context("publication stopped")?;
                        let stager = self.write_stager().await?;
                        let (stager, batch) = tokio::task::spawn_blocking(move || {
                            prepare_reservation(stager, reservation, permit)
                        })
                        .await
                        .context("reservation preparation panicked")??;
                        self.stager = Some(stager);
                        anyhow::ensure!(!*self.halted.borrow(), "publication stopped");
                        self.output
                            .send(Publication::Batch(batch))
                            .await
                            .map_err(|_| anyhow::anyhow!("publication stopped"))?;
                    }
                    Message::Status { flow, reply, .. } => {
                        let basin = self.refreshed(false).await?;
                        let latest = if let Some(viewpoint) = basin.latest(&flow)? {
                            let revision = basin
                                .flow_revision(&flow)?
                                .context("missing Flow revision")?;
                            let mut location = basin.location(&flow, &viewpoint)?;
                            // Only retained image-delta fixtures lack an indexed location.
                            if location.is_none() {
                                let mut milestone = basin.milestone.clone();
                                while milestone > 0u8.into() {
                                    let bytes = basinsync::object_read::if_present(&self.bucket)?
                                        .get_object(timeline::key(&milestone)?)
                                        .await?;
                                    anyhow::ensure!(
                                        bytes.status_code() == 200,
                                        "missing historical marker event"
                                    );
                                    if let Some(range) = event::blob_ranges(bytes.as_slice())?
                                        .into_iter()
                                        .find(|r| r.flow == flow && r.viewpoint == viewpoint)
                                    {
                                        location = Some(basinsync::turso::Location {
                                            upstream: milestone,
                                            offset: range.offset,
                                            length: range.length,
                                            sha384: range.sha384,
                                        });
                                        break;
                                    }
                                    milestone -= 1u8;
                                }
                            }
                            let location = location.context("missing committed marker location")?;
                            let access = if location.length == 0 {
                                None
                            } else if basinsync::epilogue::matches_marker(
                                &self.bucket,
                                &flow,
                                &revision,
                                &viewpoint,
                                &location,
                            )
                            .await?
                            {
                                Some(
                                    basinsync::range_get::presign(
                                        &self.bucket,
                                        &basinsync::epilogue::flow_key(
                                            &flow, &revision, &viewpoint,
                                        )?,
                                        8,
                                        location.length,
                                    )
                                    .await?,
                                )
                            } else {
                                Some(
                                    basinsync::range_get::presign(
                                        &self.bucket,
                                        &timeline::key(&location.upstream)?,
                                        location.offset,
                                        location.length,
                                    )
                                    .await?,
                                )
                            };
                            Some(LatestMarker {
                                viewpoint,
                                length: location.length,
                                access,
                            })
                        } else {
                            None
                        };
                        let response = observed(Ok(EpilogueStatus { latest }), &basin.prefix());
                        self.stager = Some(basin.into_stager());
                        let _ = reply.send(response);
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
                        let stager = self.write_stager().await?;
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
                Ok::<_, anyhow::Error>(())
            }
            .instrument(span)
            .await?;
        }
    }
}

fn maintenance_batch(
    stager: timeline::Stager,
    result: Result<Option<timeline::Prepared>>,
    reply: oneshot::Sender<Result<()>>,
    permit: OwnedSemaphorePermit,
    mut trace: obs::BatchTrace,
) -> Result<(timeline::Stager, Batch)> {
    if result.is_err() {
        trace.preparation_failed();
    }
    let (prepared, replies) = match result {
        Ok(prepared) => (prepared, vec![Reply::Cleanup(reply)]),
        Err(error) => {
            let _ = reply.send(Err(error));
            anyhow::ensure!(!stager.poisoned(), "database group restoration failed");
            (None, vec![])
        }
    };
    trace.prepared(stager.prefix().milestone());
    let batch = Batch {
        trace,
        prefix: stager.prefix(),
        prepared,
        replies,
        _permit: permit,
    };
    Ok((stager, batch))
}

fn prepare(
    mut stager: timeline::Stager,
    mut requests: Vec<QueuedCommit>,
    permit: OwnedSemaphorePermit,
) -> Result<(timeline::Stager, Batch)> {
    let mut trace = obs::BatchTrace::new("commit");
    let _entered = trace.span.clone().entered();
    for request in &mut requests {
        request.trace.assigned(&trace);
    }
    let mut expected = BTreeMap::<String, Viewpoint>::new();
    let mut commands = Vec::new();
    let mut replies = Vec::new();
    for queued in requests {
        let Commit {
            flow,
            mut marker,
            viewpoint,
            proofs,
        } = queued.request;
        let next = match expected.get(&flow) {
            Some(next) => next.clone(),
            None => stager.expected(&flow)?,
        };
        let result = if viewpoint != next {
            Err(Failure::Mismatch(ViewpointMismatch {
                next: Position { viewpoint: next },
            }))
        } else if let Some(error) = stager.check_children(&marker.edges, &proofs)? {
            Err(Failure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                error.code,
                error.message,
            ))
        } else {
            marker.verified = proofs
                .into_iter()
                .filter_map(|(id, p)| p.ok().map(|p| (id, p)))
                .collect();
            expected.insert(flow.clone(), viewpoint.next());
            commands.push(event::FlowCommand {
                markers: BTreeMap::from([(flow, marker)]),
            });
            Ok(Position { viewpoint })
        };
        replies.push(Reply::Commit(CommitReply {
            trace: queued.trace,
            channel: queued.reply,
            result,
            _admission: queued.admission,
        }));
    }
    let prepared = if commands.is_empty() {
        None
    } else {
        match stager.prepare(commands) {
            Ok(prepared) => Some(prepared),
            Err(error) => {
                trace.preparation_failed();
                anyhow::ensure!(!stager.poisoned(), "database group restoration failed");
                for reply in &mut replies {
                    if let Reply::Commit(reply) = reply
                        && reply.result.is_ok()
                    {
                        reply.result = Err(Failure::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "transaction_failed",
                            &error,
                        ));
                    }
                }
                None
            }
        }
    };
    let prefix = stager.prefix();
    trace.prepared(prefix.milestone());
    if prepared.is_some() {
        tracing::debug!(milestone=%prefix.milestone(), "batch prepared");
    } else {
        tracing::debug!(milestone=%prefix.milestone(), "batch rejected");
    }
    Ok((
        stager,
        Batch {
            trace,
            prepared,
            prefix,
            replies,
            _permit: permit,
        },
    ))
}

fn prepare_reservation(
    mut stager: timeline::Stager,
    mut reservation: QueuedReservation,
    permit: OwnedSemaphorePermit,
) -> Result<(timeline::Stager, Batch)> {
    let mut trace = obs::BatchTrace::new("reserve");
    let _entered = trace.span.clone().entered();
    reservation.trace.assigned(&trace);
    let expected = stager.expected(&reservation.request.flow)?;
    let (prepared, result) = if reservation.request.viewpoint != expected {
        (
            None,
            Err(Failure::Mismatch(ViewpointMismatch {
                next: Position {
                    viewpoint: expected,
                },
            })),
        )
    } else {
        match stager.prepare_heap(&reservation.request) {
            Ok((prepared, outcome)) => (prepared, Ok(outcome)),
            Err(error) => {
                trace.preparation_failed();
                anyhow::ensure!(!stager.poisoned(), "database group restoration failed");
                (
                    None,
                    Err(Failure::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "transaction_failed",
                        error,
                    )),
                )
            }
        }
    };
    let prefix = stager.prefix();
    trace.prepared(prefix.milestone());
    Ok((
        stager,
        Batch {
            trace,
            prepared,
            prefix,
            replies: vec![Reply::Reserve {
                trace: reservation.trace,
                channel: reservation.reply,
                result,
                _admission: reservation.admission,
            }],
            _permit: permit,
        },
    ))
}

impl Worker {
    pub(super) async fn run(
        mut self,
        mut queue: mpsc::Receiver<Message>,
        published: watch::Sender<timeline::Prefix>,
        shutdown: watch::Receiver<bool>,
    ) -> Result<()> {
        self.state.enable_vfs()?;
        let (orders, events) = mpsc::channel(2);
        let analogue_enabled = !self.analogue.max_age.is_zero();
        let analogue_job = analogue_enabled.then(|| {
            tokio::spawn(basinsync::analogue::run(
                self.bucket.clone(),
                published.subscribe(),
                self.analogue.clone(),
                events,
            ))
        });
        let (targets, snapshots) = watch::channel(self.state.snapshot()?);
        let (kernel_queue, mut kernel_requests) = mpsc::channel::<basinsync::kernel::Request>(2);
        let maintenance = self.maintenance.clone();
        let kernel_bridge = tokio::spawn(async move {
            while let Some(request) = kernel_requests.recv().await {
                if let Err(error) = maintenance.send(Message::Kernel(request)).await
                    && let Message::Kernel(request) = error.0
                {
                    let _ = request
                        .reply
                        .send(Err(anyhow::anyhow!("request handler closed")));
                }
            }
        });
        let (backup_stop, backup_shutdown) = watch::channel(false);
        let backup_on_shutdown = self.backup_on_shutdown;
        let backup_job = if !self.backup_interval.is_zero() || backup_on_shutdown {
            Some(tokio::spawn(basinsync::backup::run(
                self.bucket.clone(),
                snapshots.clone(),
                self.backup_interval,
                kernel_queue,
                backup_shutdown,
                backup_on_shutdown,
                basinsync::kernel::promotion::Limits {
                    tasks: self.cleanup.tasks,
                    nodes: self.cleanup.marking,
                    concurrency: self.cleanup.concurrency,
                },
            )))
        } else {
            drop(kernel_queue);
            None
        };
        let telemetry_snapshots = snapshots.clone();
        let snapshots = (!self.cleanup.interval.is_zero()).then_some(snapshots);
        let backups = Some(targets);
        let (output, receiver) = mpsc::channel(PIPELINE_BATCHES - 1);
        let published_rx = published.subscribe();
        let (signal, halted) = watch::channel(false);
        let telemetry = tokio::spawn(obs::sample_loop(
            telemetry_snapshots,
            shutdown.clone(),
            halted.clone(),
        ));
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
            analogue_enabled.then_some(orders),
        ));
        let coordination_queue = self.maintenance.clone();
        let cleanup_job = snapshots.map(|snapshots| {
            tokio::spawn(cleanup_loop(
                self.bucket.clone(),
                snapshots,
                self.maintenance,
                self.cleanup,
                halted.clone(),
                shutdown.clone(),
            ))
        });
        let (drain, preparation_shutdown) = watch::channel(false);
        let mut external_shutdown = shutdown.clone();
        let mut failed = halted.clone();
        let maintenance = coordination_queue;
        let coordinator = tokio::spawn(async move {
            if !*external_shutdown.borrow() && !*failed.borrow() {
                tokio::select! { _=external_shutdown.changed()=>{}, _=failed.changed()=>{} }
            }
            if backup_on_shutdown && backup_job.is_some() && !*failed.borrow() {
                let (reply, complete) = oneshot::channel();
                if maintenance
                    .send(Message::BackupBarrier(reply))
                    .await
                    .is_ok()
                {
                    let _ = complete.await;
                }
            }
            backup_stop.send_replace(true);
            let backup = if let Some(job) = backup_job {
                job.await.context("backup task panicked")
            } else {
                Ok(())
            };
            drain.send_replace(true);
            backup
        });
        let mut preparation = Preparation {
            bucket: self.bucket,
            stager: Some(self.state.into_stager()),
            output,
            published: published_rx,
            halted,
            shutdown: preparation_shutdown,
            draining: false,
            batches,
            batch_max: self.batch_max,
            batch_wait: self.batch_wait,
            status_probe_max_age: self.status_probe_max_age,
            last_probe: None,
        };
        let result = preparation.run(&mut queue).await;
        if let Err(error) = &result {
            tracing::error!(%error, "preparation stopped");
            stop.stop();
            queue.close();
            while let Ok(message) = queue.try_recv() {
                message.reject(&preparation.published.borrow());
            }
        }
        drop(preparation);
        let publication = publisher
            .await
            .context("publication task panicked")
            .and_then(|r| r);
        let cleanup_result = if let Some(job) = cleanup_job {
            job.await.context("cleanup task panicked")
        } else {
            Ok(())
        };
        let backup_result = coordinator.await.context("shutdown coordinator panicked")?;
        telemetry.await.context("telemetry sampler panicked")?;
        cleanup_result?;
        backup_result?;
        kernel_bridge
            .await
            .context("kernel request bridge panicked")?;
        if let Some(job) = analogue_job {
            job.await.context("Analogue worker panicked")?;
        }
        result.and(publication)
    }
}

pub(super) struct CleanupConfig {
    pub interval: Duration,
    pub tasks: usize,
    pub edges: usize,
    pub nodes: usize,
    pub concurrency: usize,
    pub marking: usize,
}
async fn maintenance(queue: &mpsc::Sender<Message>, command: cleanup::Command) -> Result<()> {
    let slot = queue.try_reserve().context("request queue busy")?;
    let (reply, complete) = oneshot::channel();
    slot.send(Message::Cleanup { command, reply });
    complete.await.context("cleanup publication stopped")?
}
async fn promote_maintenance(
    queue: &mpsc::Sender<Message>,
    command: basinsync::promotion::Command,
) -> Result<()> {
    let slot = queue.try_reserve().context("request queue busy")?;
    let (reply, complete) = oneshot::channel();
    slot.send(Message::Promote { command, reply });
    complete.await.context("promotion publication stopped")?
}
async fn cleanup_loop(
    bucket: Box<Bucket>,
    snapshots: watch::Receiver<Option<timeline::Snapshot>>,
    queue: mpsc::Sender<Message>,
    config: CleanupConfig,
    mut halted: watch::Receiver<bool>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *halted.borrow() || *shutdown.borrow() {
            return;
        }
        tokio::select! { _ = halted.changed() => return, _ = shutdown.changed() => return, _ = tokio::time::sleep(config.interval) => {} }
        let Some(snapshot) = snapshots.borrow().clone() else {
            continue;
        };
        let tasks = config.tasks;
        let nodes = config.nodes;
        let cycle = async {
            let work = tokio::task::spawn_blocking(move || cleanup::scan(&snapshot, tasks, nodes))
                .await
                .context("cleanup scan panicked")??;
            if !work.tasks.is_empty() {
                maintenance(
                    &queue,
                    cleanup::Command {
                        tasks: work.tasks,
                        erased: vec![],
                        detaching: vec![],
                        freed_at: cleanup::now()?,
                        edge_limit: config.edges,
                    },
                )
                .await?;
            }
            if !work.detaching.is_empty() {
                maintenance(
                    &queue,
                    cleanup::Command {
                        tasks: vec![],
                        erased: vec![],
                        detaching: work.detaching,
                        freed_at: cleanup::now()?,
                        edge_limit: config.edges,
                    },
                )
                .await?;
            }
            let erased = cleanup::erase(&bucket, work.freed, config.concurrency).await;
            if !erased.is_empty() {
                maintenance(
                    &queue,
                    cleanup::Command {
                        tasks: vec![],
                        erased,
                        detaching: vec![],
                        freed_at: cleanup::now()?,
                        edge_limit: config.edges,
                    },
                )
                .await?;
            }
            let Some(snapshot) = snapshots.borrow().clone() else {
                return Ok(());
            };
            let marking = config.marking;
            let work = tokio::task::spawn_blocking(move || {
                basinsync::promotion::scan(&snapshot, tasks, marking)
            })
            .await
            .context("marking scan panicked")??;
            if !work.marking.marked.is_empty() {
                promote_maintenance(&queue, work.marking).await?;
            }
            let promoted =
                basinsync::promotion::promote(&bucket, work.promote, config.concurrency).await;
            if !promoted.is_empty() {
                promote_maintenance(
                    &queue,
                    basinsync::promotion::Command {
                        promoted,
                        at: cleanup::now()?,
                        ..Default::default()
                    },
                )
                .await?;
            }
            let signed =
                basinsync::promotion::confirm_signs(&bucket, work.ready, config.concurrency).await;
            if !signed.is_empty() {
                promote_maintenance(
                    &queue,
                    basinsync::promotion::Command {
                        signed,
                        at: cleanup::now()?,
                        ..Default::default()
                    },
                )
                .await?;
            }
            Ok::<_, anyhow::Error>(())
        };
        // Finish the current phase (including S3 cleanup) rather than dropping it.
        if let Err(error) = obs::measured("cleanup", "userspace", cycle).await {
            tracing::warn!(%error,"cleanup deferred");
        }
    }
}

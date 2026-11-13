use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, FromRequest, Multipart, Query, State, multipart::MultipartRejection,
        rejection::QueryRejection,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use basinsync::{
    cleanup,
    details::CommitDetails,
    diffuse16,
    event::{self, Marker},
    heap,
    lexidecimal::Viewpoint,
    timeline,
};
use s3::{Bucket, Region, creds::Credentials};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::{env, future::IntoFuture, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};

const MAX_BODY: usize = 8 * 1024 * 1024;
const PIPELINE_BATCHES: usize = 2;

mod server_pipeline;

struct App {
    queue: mpsc::Sender<Message>,
    admission: Arc<Semaphore>,
    published: watch::Receiver<timeline::Prefix>,
    bucket: Box<Bucket>,
    heap_limits: heap::Limits,
    heap_heads: Arc<Semaphore>,
}

type Shared = Arc<App>;

#[derive(Clone, Serialize)]
struct ApiError {
    #[serde(serialize_with = "basinsync::json0::serialize_text")]
    error: &'static str,
    #[serde(serialize_with = "basinsync::json0::serialize_text")]
    message: String,
}

#[derive(Clone)]
enum Failure {
    Error(StatusCode, ApiError),
    Mismatch(ViewpointMismatch),
}

#[derive(Clone, Serialize)]
struct ViewpointMismatch {
    next: Position,
}

impl Failure {
    fn new(status: StatusCode, error: &'static str, message: impl ToString) -> Self {
        Self::Error(
            status,
            ApiError {
                error,
                message: message.to_string(),
            },
        )
    }
    fn bad(message: impl ToString) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
}
#[derive(Clone, Serialize)]
struct TimelinePosition {
    #[serde(serialize_with = "basinsync::json0::serialize_biguint")]
    milestone: num_bigint::BigUint,
}

#[derive(Clone, Serialize)]
struct Timelines {
    watershed: TimelinePosition,
}

#[derive(Serialize)]
struct ApiResponse<T> {
    #[serde(flatten)]
    body: T,
    timelines: Timelines,
}

struct ApiFailure {
    failure: Failure,
    timelines: Timelines,
}
type ApiReply<T> = Result<ApiResponse<T>, ApiFailure>;

fn observed<T>(result: Result<T, Failure>, prefix: &timeline::Prefix) -> ApiReply<T> {
    let timelines = Timelines {
        watershed: TimelinePosition {
            milestone: prefix.milestone().clone(),
        },
    };
    match result {
        Ok(body) => Ok(ApiResponse { body, timelines }),
        Err(failure) => Err(ApiFailure { failure, timelines }),
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        let Self { failure, timelines } = self;
        match failure {
            Failure::Error(status, body) => {
                (status, Json(ApiResponse { body, timelines })).into_response()
            }
            Failure::Mismatch(body) => {
                (StatusCode::CONFLICT, Json(ApiResponse { body, timelines })).into_response()
            }
        }
    }
}

impl App {
    fn respond<T: Serialize>(
        &self,
        status: StatusCode,
        result: Result<ApiReply<T>, Failure>,
    ) -> Response {
        match result.unwrap_or_else(|failure| observed(Err(failure), &self.published.borrow())) {
            Ok(body) => (status, Json(body)).into_response(),
            Err(failure) => failure.into_response(),
        }
    }

    fn failure(&self, failure: Failure) -> Response {
        self.respond::<Position>(StatusCode::OK, Err(failure))
    }
}

struct Commit {
    proofs: heap::Proofs,
    flow: String,
    marker: Marker,
    viewpoint: Viewpoint,
}

impl Commit {
    async fn read(mut form: Multipart, limits: &heap::Limits) -> Result<Self, Failure> {
        let (mut details, mut blob) = (None, None);
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?
        {
            let name = field.name().unwrap_or("").to_owned();
            let slot = match name.as_str() {
                "details" if details.is_none() => &mut details,
                "blob" if blob.is_none() => &mut blob,
                _ => return Err(Failure::bad("unknown, unnamed, or duplicate field")),
            };
            *slot = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?,
            );
        }
        let CommitDetails {
            flow,
            viewpoint,
            sha384,
            edges,
        } = serde_json::from_slice(&details.ok_or_else(|| Failure::bad("missing details"))?)
            .map_err(|_| Failure::bad("invalid commit details"))?;
        let edges = heap::authenticate_edges(edges, limits, None)
            .map_err(|e| Failure::new(StatusCode::UNPROCESSABLE_ENTITY, e.code, e.message))?;
        event::valid_flow(&flow).map_err(Failure::bad)?;
        basinsync::epilogue::flow_key(&flow, &viewpoint).map_err(Failure::bad)?;
        let blob = blob.ok_or_else(|| Failure::bad("missing blob"))?;
        let digest = Sha384::digest(&blob);
        if sha384.as_slice() != &digest[..] {
            return Err(Failure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "digest_mismatch",
                "sha384 must equal the blob's 48-byte SHA-384",
            ));
        }
        Ok(Self {
            proofs: Default::default(),
            flow,
            marker: Marker {
                edges,
                verified: Default::default(),
                viewpoint: viewpoint.decimal(),
                sha384: format!("{digest:x}"),
                blob: blob.to_vec(),
            },
            viewpoint,
        })
    }
}

#[derive(Clone, Serialize)]
struct Position {
    #[serde(serialize_with = "basinsync::json0::serialize_viewpoint")]
    viewpoint: Viewpoint,
}

#[derive(Serialize)]
struct EpilogueStatus {
    latest: Option<LatestMarker>,
}

#[derive(Serialize)]
struct LatestMarker {
    #[serde(serialize_with = "basinsync::json0::serialize_viewpoint")]
    viewpoint: Viewpoint,
    length: u64,
    #[serde(flatten)]
    access: Option<basinsync::range_get::Access>,
}

async fn commit(
    State(app): State<Shared>,
    form: Result<Multipart, MultipartRejection>,
) -> Response {
    let result = async {
        let form =
            form.map_err(|error| Failure::new(error.status(), "invalid_multipart", error))?;
        let admission = app
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| stopped())?;
        let mut request = Commit::read(form, &app.heap_limits).await?;
        if !request.marker.edges.is_empty() {
            let (reply, received) = oneshot::channel();
            app.queue
                .send(Message::InspectCommit { request, reply })
                .await
                .map_err(|_| stopped())?;
            request = received
                .await
                .map_err(|_| stopped())?
                .map_err(|_| stopped())?;
            heap::verify_children(&mut request.proofs, &app.bucket, app.heap_heads.clone()).await;
        }
        let (reply, result) = oneshot::channel();
        let queued = tracing::enabled!(tracing::Level::DEBUG)
            .then(|| (request.flow.clone(), request.viewpoint.decimal()));
        app.queue
            .send(Message::Commit(QueuedCommit {
                request,
                reply,
                admission,
            }))
            .await
            .map_err(|_| stopped())?;
        if let Some((flow, viewpoint)) = queued {
            tracing::debug!(%flow,%viewpoint,"commit queued");
        }
        result.await.map_err(|_| stopped())
    }
    .await;
    app.respond(StatusCode::CREATED, result)
}

fn stopped() -> Failure {
    Failure::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "stopped",
        "commit worker is stopping; outcome may be unknown",
    )
}
struct QueuedCommit {
    request: Commit,
    admission: OwnedSemaphorePermit,
    reply: oneshot::Sender<ApiReply<Position>>,
}
struct QueuedReservation {
    request: heap::Request,
    admission: OwnedSemaphorePermit,
    reply: oneshot::Sender<ApiReply<heap::Outcome>>,
}
impl QueuedCommit {
    fn size(&self) -> usize {
        self.request.flow.len()
            + self.request.marker.viewpoint.len()
            + self.request.marker.blob.len()
            + self.request.marker.sha384.len()
    }
}
enum Message {
    InspectCommit {
        request: Commit,
        reply: oneshot::Sender<Result<Commit>>,
    },
    Promote {
        command: basinsync::promotion::Command,
        reply: oneshot::Sender<Result<()>>,
    },
    Commit(QueuedCommit),
    Reserve(QueuedReservation),
    InspectHeap {
        request: heap::Request,
        reply: oneshot::Sender<Result<heap::Request>>,
    },
    Cleanup {
        command: cleanup::Command,
        reply: oneshot::Sender<Result<()>>,
    },
    Status {
        flow: String,
        reply: oneshot::Sender<ApiReply<EpilogueStatus>>,
    },
}
impl Message {
    fn reject(self, prefix: &timeline::Prefix) {
        match self {
            Self::Commit(c) => {
                let _ = c.reply.send(observed(Err(stopped()), prefix));
            }
            Self::Reserve(r) => {
                let _ = r.reply.send(observed(Err(stopped()), prefix));
            }
            Self::InspectCommit { reply, .. } => {
                let _ = reply.send(Err(anyhow::anyhow!("publication stopped")));
            }
            Self::Promote { reply, .. } => {
                let _ = reply.send(Err(anyhow::anyhow!("publication stopped")));
            }
            Self::InspectHeap { reply, .. } => {
                let _ = reply.send(Err(anyhow::anyhow!("publication stopped")));
            }
            Self::Cleanup { reply, .. } => {
                let _ = reply.send(Err(anyhow::anyhow!("publication stopped")));
            }
            Self::Status { reply, .. } => {
                let _ = reply.send(observed(Err(stopped()), prefix));
            }
        }
    }
}
struct Worker {
    maintenance: mpsc::Sender<Message>,
    cleanup: server_pipeline::CleanupConfig,
    bucket: Box<Bucket>,
    state: timeline::Watershed,
    batch_max: usize,
    batch_wait: Duration,
    backup_interval: Duration,
    status_probe_max_age: Duration,
}

#[derive(Deserialize)]
struct FlowQuery {
    flow: String,
}

async fn epilogue_status(
    State(app): State<Shared>,
    query: Result<Query<FlowQuery>, QueryRejection>,
) -> Response {
    let result = async {
        let Query(query) =
            query.map_err(|error| Failure::new(error.status(), "invalid_query", error))?;
        event::valid_flow(&query.flow).map_err(Failure::bad)?;
        basinsync::epilogue::flow_key(&query.flow, &Viewpoint::zero()).map_err(Failure::bad)?;
        let (reply, result) = oneshot::channel();
        app.queue
            .send(Message::Status {
                flow: query.flow,
                reply,
            })
            .await
            .map_err(|_| stopped())?;
        result.await.map_err(|_| stopped())
    }
    .await;
    app.respond(StatusCode::OK, result)
}

async fn heap_reserve(State(app): State<Shared>, body: axum::extract::Request) -> Response {
    let result = async {
        let admission = app
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| stopped())?;
        let body = Bytes::from_request(body, &app).await.map_err(|e| {
            Failure::new(e.status(), "invalid_request", "invalid heap request body")
        })?;
        let mut request = heap::Request::parse(&body, &app.heap_limits)
            .map_err(|_| Failure::bad("invalid heap request"))?;
        if request
            .nodes
            .iter()
            .filter_map(|n| n.as_ref().ok())
            .any(|n| !n.edges.is_empty())
        {
            let (reply, inspected) = oneshot::channel();
            app.queue
                .send(Message::InspectHeap { request, reply })
                .await
                .map_err(|_| stopped())?;
            request = inspected
                .await
                .map_err(|_| stopped())?
                .map_err(|_| stopped())?;
            request
                .verify_children(&app.bucket, app.heap_heads.clone())
                .await;
        }
        let (reply, result) = oneshot::channel();
        app.queue
            .send(Message::Reserve(QueuedReservation {
                request,
                admission,
                reply,
            }))
            .await
            .map_err(|_| stopped())?;
        let result = result.await.map_err(|_| stopped())?;
        Ok(match result {
            Ok(response) => match response.body.actions(&app.bucket).await {
                Ok(body) => Ok(ApiResponse {
                    body,
                    timelines: response.timelines,
                }),
                Err(_) => Err(ApiFailure {
                    failure: Failure::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "signing_failed",
                        "unable to sign heap actions; reservation may already be durable",
                    ),
                    timelines: response.timelines,
                }),
            },
            Err(error) => Err(error),
        })
    }
    .await;
    app.respond(StatusCode::OK, result)
}

fn required(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("set {name}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "basinsync=info".into()),
        )
        .init();
    s3::set_retries(0);
    let region = Region::Custom {
        region: env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()),
        endpoint: required("S3_ENDPOINT")?,
    };
    let credentials = Credentials::new(
        Some(&required("AWS_ACCESS_KEY_ID")?),
        Some(&required("AWS_SECRET_ACCESS_KEY")?),
        None,
        env::var("AWS_SESSION_TOKEN")
            .ok()
            .filter(|token| !token.is_empty())
            .as_deref(),
        None,
    )?;
    let bucket = Bucket::new(&required("S3_BUCKET")?, region, credentials)?
        .with_path_style()
        .with_request_timeout(Duration::from_secs(10))?;
    let state = timeline::recover(&bucket)
        .await
        .context("recover Watershed Timeline")?;
    let (published, published_rx) = watch::channel(state.prefix());
    let next = &state.milestone + 1u8;
    diffuse16::key(&next)?;
    let (fatal_tx, mut fatal_rx) = watch::channel(false);
    let mut shutdown_rx = fatal_rx.clone();
    let batch_max: usize = env::var("BASINSYNC_BATCH_MAX")
        .unwrap_or_else(|_| "32".into())
        .parse()?;
    let batch_wait: u64 = env::var("BASINSYNC_BATCH_WAIT_MS")
        .unwrap_or_else(|_| "2".into())
        .parse()?;
    anyhow::ensure!(
        (1..=256).contains(&batch_max) && batch_wait <= 1000,
        "invalid batch limits"
    );
    let capacity = (batch_max * PIPELINE_BATCHES).max(32);
    let (queue, receiver) = mpsc::channel(capacity);
    let heap_limits = heap::Limits {
        max_degree: env::var("BASINSYNC_NODE_MAX_DEGREE")
            .unwrap_or_else(|_| "128".into())
            .parse()?,
        max_height: env::var("BASINSYNC_HEAP_MAX_HEIGHT")
            .unwrap_or_else(|_| "128".into())
            .parse()?,
        max_token_bytes: env::var("BASINSYNC_HEAP_MAX_TOKEN_BYTES")
            .unwrap_or_else(|_| "64".into())
            .parse()?,
    };
    let signing_bucket = bucket.clone();
    let cleanup = server_pipeline::CleanupConfig {
        allow_transfer: env::var("BASINSYNC_PROMOTION_ALLOW_TRANSFER")
            .unwrap_or_else(|_| "false".into())
            .parse()?,
        marking: env::var("BASINSYNC_MARK_BATCH_SIZE")
            .unwrap_or_else(|_| "256".into())
            .parse()?,
        interval: Duration::from_millis(
            env::var("BASINSYNC_CLEANUP_INTERVAL_MS")
                .unwrap_or_else(|_| "1000".into())
                .parse()?,
        ),
        tasks: env::var("BASINSYNC_SWEEP_BATCH_SIZE")
            .unwrap_or_else(|_| "16".into())
            .parse()?,
        edges: env::var("BASINSYNC_SWEEP_EDGE_BATCH_SIZE")
            .unwrap_or_else(|_| "256".into())
            .parse()?,
        nodes: env::var("BASINSYNC_ERASE_BATCH_SIZE")
            .unwrap_or_else(|_| "32".into())
            .parse()?,
        concurrency: env::var("BASINSYNC_ERASE_CONCURRENCY")
            .unwrap_or_else(|_| "4".into())
            .parse()?,
    };
    anyhow::ensure!(
        (1..=4096).contains(&cleanup.marking)
            && (1..=4096).contains(&cleanup.tasks)
            && (1..=4096).contains(&cleanup.edges)
            && (1..=4096).contains(&cleanup.nodes)
            && (1..=32).contains(&cleanup.concurrency),
        "invalid cleanup limits"
    );
    let worker = Worker {
        maintenance: queue.clone(),
        cleanup,
        bucket,
        state,
        batch_max,
        batch_wait: Duration::from_millis(batch_wait),
        backup_interval: Duration::from_millis(
            env::var("BASINSYNC_BACKUP_INTERVAL_MS")
                .unwrap_or_else(|_| "1000".into())
                .parse()?,
        ),
        status_probe_max_age: Duration::from_millis(
            env::var("BASINSYNC_STATUS_PROBE_MAX_AGE_MS")
                .unwrap_or_else(|_| "3000".into())
                .parse()?,
        ),
    };
    let job = tokio::spawn(worker.run(receiver, published));
    tokio::spawn(async move {
        match job.await {
            Ok(Ok(())) => {}
            result => {
                tracing::error!(?result, "commit worker stopped");
                fatal_tx.send_replace(true);
            }
        }
    });
    let app = Arc::new(App {
        queue,
        admission: Arc::new(Semaphore::new(capacity)),
        published: published_rx,
        bucket: signing_bucket,
        heap_limits,
        heap_heads: Arc::new(Semaphore::new(8)),
    });
    let api = Router::new()
        .route("/epilogue", put(commit))
        .route("/epilogue/status", get(epilogue_status))
        .route("/heap/reserve", post(heap_reserve))
        .fallback(|State(app): State<Shared>| async move {
            app.failure(Failure::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "route not found",
            ))
        })
        .method_not_allowed_fallback(|State(app): State<Shared>| async move {
            app.failure(Failure::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "method not allowed",
            ))
        });
    let router = Router::new()
        .nest("/api/v0", api)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(app);
    let address: SocketAddr = env::var("BASINSYNC_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:3000".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(address = %listener.local_addr()?, next_milestone = %next, "ready");
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! { _ = shutdown_rx.changed() => {}, _ = tokio::signal::ctrl_c() => {} }
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => { result?; }
        _ = fatal_rx.changed() => {
            // Let the failing request send its response, but bound shutdown if
            // another client holds an incomplete HTTP request open.
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut server).await;
        }
    }
    if *fatal_rx.borrow() {
        bail!("commit worker stopped");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_use_json0_bigints_and_escape_literal_strings() {
        let viewpoint = Viewpoint::parse("340282366920938463463374607431768211456").unwrap();
        let prefix = timeline::Watershed {
            milestone: "340282366920938463463374607431768211457".parse().unwrap(),
            ..Default::default()
        }
        .prefix();
        let status = observed(
            Ok(EpilogueStatus {
                latest: Some(LatestMarker {
                    viewpoint,
                    length: 0,
                    access: None,
                }),
            }),
            &prefix,
        )
        .ok()
        .unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "latest": {"viewpoint": "0x100000000000000000000000000000000", "length": 0},
                "timelines": {"watershed": {"milestone": "0x100000000000000000000000000000001"}},
            })
        );
        assert_eq!(
            serde_json::to_value(
                observed(
                    Ok(ApiError {
                        error: "0x_literal",
                        message: "0$message".into(),
                    }),
                    &prefix
                )
                .ok()
                .unwrap()
            )
            .unwrap(),
            serde_json::json!({"error": "00x_literal", "message": "00$message", "timelines": {"watershed": {"milestone": "0x100000000000000000000000000000001"}}})
        );
    }
}

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Multipart, Query, State, multipart::MultipartRejection,
        rejection::QueryRejection,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
};
use basinsync::{
    diffuse16,
    event::{self, Marker},
    lexidecimal::Viewpoint,
    metadata::CommitMetadata,
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
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Self::Error(status, body) => (status, Json(body)).into_response(),
            Self::Mismatch(body) => (StatusCode::CONFLICT, Json(body)).into_response(),
        }
    }
}

struct Commit {
    flow: String,
    marker: Marker,
    viewpoint: Viewpoint,
}

impl Commit {
    async fn read(mut form: Multipart) -> Result<Self, Failure> {
        let (mut metadata, mut blob) = (None, None);
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?
        {
            let name = field.name().unwrap_or("").to_owned();
            let slot = match name.as_str() {
                "metadata" if metadata.is_none() => &mut metadata,
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
        let CommitMetadata {
            flow,
            viewpoint,
            sha384,
        } = serde_json::from_slice(&metadata.ok_or_else(|| Failure::bad("missing metadata"))?)
            .map_err(Failure::bad)?;
        event::valid_flow(&flow).map_err(Failure::bad)?;
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
            flow,
            marker: Marker {
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
    latest: Option<Position>,
    recent: Option<RecentMarker>,
}

#[derive(Serialize)]
struct RecentMarker {
    #[serde(serialize_with = "basinsync::json0::serialize_viewpoint")]
    viewpoint: Viewpoint,
    #[serde(serialize_with = "basinsync::json0::serialize_text")]
    url: String,
}

async fn commit(
    State(app): State<Shared>,
    form: Result<Multipart, MultipartRejection>,
) -> Result<impl IntoResponse, Failure> {
    let form = form.map_err(|error| Failure::new(error.status(), "invalid_multipart", error))?;
    let admission = app
        .admission
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| stopped())?;
    let request = Commit::read(form).await?;
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
    let position = result.await.map_err(|_| stopped())??;
    Ok((StatusCode::CREATED, Json(position)))
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
    reply: oneshot::Sender<Result<Position, Failure>>,
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
    Commit(QueuedCommit),
    Status {
        flow: String,
        reply: oneshot::Sender<Result<EpilogueStatus, Failure>>,
    },
}
impl Message {
    fn reject(self) {
        match self {
            Self::Commit(c) => {
                let _ = c.reply.send(Err(stopped()));
            }
            Self::Status { reply, .. } => {
                let _ = reply.send(Err(stopped()));
            }
        }
    }
}
struct Worker {
    bucket: Box<Bucket>,
    state: timeline::Basin,
    batch_max: usize,
    batch_wait: Duration,
}

#[derive(Deserialize)]
struct FlowQuery {
    flow: String,
}

async fn epilogue_status(
    State(app): State<Shared>,
    query: Result<Query<FlowQuery>, QueryRejection>,
) -> Result<Json<EpilogueStatus>, Failure> {
    let Query(query) =
        query.map_err(|error| Failure::new(error.status(), "invalid_query", error))?;
    event::valid_flow(&query.flow).map_err(Failure::bad)?;
    let (reply, result) = oneshot::channel();
    app.queue
        .send(Message::Status {
            flow: query.flow,
            reply,
        })
        .await
        .map_err(|_| stopped())?;
    Ok(Json(result.await.map_err(|_| stopped())??))
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
        .context("recover Basin Timeline")?;
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
    let worker = Worker {
        bucket,
        state,
        batch_max,
        batch_wait: Duration::from_millis(batch_wait),
    };
    let job = tokio::spawn(worker.run(receiver));
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
    });
    let api = Router::new()
        .route("/epilogue", put(commit))
        .route("/epilogue/status", get(epilogue_status))
        .fallback(|| async { Failure::new(StatusCode::NOT_FOUND, "not_found", "route not found") })
        .method_not_allowed_fallback(|| async {
            Failure::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "method not allowed",
            )
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
        let status = EpilogueStatus {
            latest: Some(Position { viewpoint }),
            recent: Some(RecentMarker {
                viewpoint: Viewpoint::zero(),
                url: "0x/literal".into(),
            }),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "latest": {"viewpoint": "0x100000000000000000000000000000000"},
                "recent": {"viewpoint": "0x0", "url": "00x/literal"},
            })
        );
        assert_eq!(
            serde_json::to_value(ApiError {
                error: "0x_literal",
                message: "0$message".into(),
            })
            .unwrap(),
            serde_json::json!({"error": "00x_literal", "message": "00$message"})
        );
    }
}

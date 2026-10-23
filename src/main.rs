use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
};
use basinsync::{
    diffuse16,
    event::{self, Marker},
    lexidecimal::Viewpoint,
    timeline,
};
use s3::{Bucket, Region, creds::Credentials};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::{env, future::IntoFuture, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{Mutex, watch};

const MAX_BODY: usize = 8 * 1024 * 1024;

struct App {
    bucket: Box<Bucket>,
    state: Mutex<timeline::Basin>,
    fatal: watch::Sender<bool>,
}

type Shared = Arc<App>;

#[derive(Serialize)]
struct ApiError {
    error: &'static str,
    message: String,
}

enum Failure {
    Error(StatusCode, ApiError),
    Mismatch(ViewpointMismatch),
}

#[derive(Serialize)]
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
    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error);
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "operation failed",
        )
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
        let (mut flow, mut blob, mut sha384, mut viewpoint) = (None, None, None, None);
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?
        {
            let name = field.name().unwrap_or("").to_owned();
            match name.as_str() {
                "flow" if flow.is_none() => {
                    flow = Some(
                        field
                            .text()
                            .await
                            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?,
                    );
                }
                "blob" if blob.is_none() => {
                    blob = Some(
                        field
                            .bytes()
                            .await
                            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?,
                    );
                }
                "sha384" if sha384.is_none() => {
                    sha384 = Some(
                        field
                            .text()
                            .await
                            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?,
                    );
                }
                "viewpoint" if viewpoint.is_none() => {
                    viewpoint = Some(
                        field
                            .text()
                            .await
                            .map_err(|e| Failure::new(e.status(), "invalid_multipart", e))?,
                    );
                }
                _ => return Err(Failure::bad("unknown, unnamed, or duplicate field")),
            }
        }
        let flow = flow.ok_or_else(|| Failure::bad("missing flow"))?;
        event::valid_flow(&flow).map_err(Failure::bad)?;
        let blob = blob.ok_or_else(|| Failure::bad("missing blob"))?;
        let viewpoint =
            Viewpoint::parse(&viewpoint.ok_or_else(|| Failure::bad("missing viewpoint"))?)
                .map_err(Failure::bad)?;
        let digest = format!("{:x}", Sha384::digest(&blob));
        if sha384.ok_or_else(|| Failure::bad("missing sha384"))? != digest {
            return Err(Failure::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "digest_mismatch",
                "sha384 must equal the blob's 96-character lowercase hexadecimal SHA-384",
            ));
        }
        Ok(Self {
            flow,
            marker: Marker {
                viewpoint: viewpoint.decimal(),
                sha384: digest,
                blob: blob.to_vec(),
            },
            viewpoint,
        })
    }
}

#[derive(Serialize)]
struct Position {
    viewpoint: String,
}

#[derive(Serialize)]
struct EpilogueStatus {
    latest: Option<Position>,
    recent: Option<RecentMarker>,
}

#[derive(Serialize)]
struct RecentMarker {
    viewpoint: String,
    url: String,
}

async fn commit(State(app): State<Shared>, form: Multipart) -> Result<impl IntoResponse, Failure> {
    let request = Commit::read(form).await?;
    // Detach the transaction from the HTTP request: a disconnected client must
    // not cancel a durable PUT before we advance (or poison) the local cursor.
    tokio::spawn(async move { app.commit(request).await })
        .await
        .map_err(Failure::internal)?
}

impl App {
    async fn commit(&self, request: Commit) -> Result<(StatusCode, Json<Position>), Failure> {
        let mut state = self.state.lock().await;
        if state.stopped {
            return Err(Failure::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "stopped",
                "server is stopping",
            ));
        }
        timeline::refresh(&self.bucket, &mut state)
            .await
            .map_err(Failure::internal)?;
        let expected = state.expected(&request.flow);
        if request.viewpoint != expected {
            let next = Position {
                viewpoint: expected.decimal(),
            };
            return Err(Failure::Mismatch(ViewpointMismatch { next }));
        }
        let moment = &state.moment + 1u8;
        let key = diffuse16::key(&moment).map_err(Failure::bad)?;
        let bytes =
            event::encode(request.flow.clone(), request.marker).map_err(Failure::internal)?;
        let result = self
            .bucket
            .put_object_with_headers(
                &key,
                &bytes,
                Some(axum::http::HeaderMap::from_iter([(
                    axum::http::header::IF_NONE_MATCH,
                    axum::http::HeaderValue::from_static("*"),
                )])),
            )
            .await;
        match result {
            Ok(response) if (200..300).contains(&response.status_code()) => {
                state.moment = moment.clone();
                state
                    .flows
                    .insert(request.flow.clone(), request.viewpoint.clone());
                tracing::info!(flow = %request.flow, moment = %moment, viewpoint = %request.viewpoint.decimal(), "put of success");
                Ok((
                    StatusCode::CREATED,
                    Json(Position {
                        viewpoint: request.viewpoint.decimal(),
                    }),
                ))
            }
            other => {
                // Even a timeout may mean S3 stored the marker. Never guess or
                // retry in this process; restart replays the authoritative Timeline.
                state.stopped = true;
                self.fatal.send_replace(true);
                tracing::error!(result = ?other, "conditional PUT failed; relinquishing leadership");
                Err(Failure::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "leadership_lost",
                    "conditional PUT failed; server is stopping; outcome may be unknown",
                ))
            }
        }
    }
}

#[derive(Deserialize)]
struct FlowQuery {
    flow: String,
}

async fn epilogue_status(
    State(app): State<Shared>,
    Query(query): Query<FlowQuery>,
) -> Result<Json<EpilogueStatus>, Failure> {
    event::valid_flow(&query.flow).map_err(Failure::bad)?;
    let mut state = app.state.lock().await;
    if state.stopped {
        return Err(Failure::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "stopped",
            "server is stopping",
        ));
    }
    timeline::refresh(&app.bucket, &mut state)
        .await
        .map_err(Failure::internal)?;
    let latest = state.flows.get(&query.flow).map(|viewpoint| Position {
        viewpoint: viewpoint.decimal(),
    });
    Ok(Json(EpilogueStatus {
        latest,
        recent: None,
    }))
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
    let next = &state.moment + 1u8;
    diffuse16::key(&next)?;
    let (fatal_tx, mut fatal_rx) = watch::channel(false);
    let mut shutdown_rx = fatal_rx.clone();
    let app = Arc::new(App {
        bucket,
        state: Mutex::new(state),
        fatal: fatal_tx,
    });
    let api = Router::new()
        .route("/epilogue", put(commit))
        .route("/epilogue/status", get(epilogue_status));
    let router = Router::new()
        .nest("/api/v0", api)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(app);
    let address: SocketAddr = env::var("BASINSYNC_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:3000".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(address = %listener.local_addr()?, next_moment = %next, "ready");
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
        bail!("leadership lost: conditional PUT failed");
    }
    Ok(())
}

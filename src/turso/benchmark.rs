use super::*;
use crate::{diffuse16, event};
use s3::{Bucket, Region, creds::Credentials};
use serde::Serialize;
use std::{env, fs, path::PathBuf, time::Instant};

#[derive(Serialize)]
struct Sample {
    variant: &'static str,
    milestone: usize,
    total_us: f64,
    phases_us: BTreeMap<String, f64>,
    database_bytes: usize,
    event_bytes: usize,
}

#[test]
#[ignore = "explicit benchmark; requires BENCH_VARIANT and BENCH_OUTPUT"]
fn commits() -> Result<()> {
    let variant = env::var("BENCH_VARIANT")?;
    let variant = match variant.as_str() {
        "builtin" => "builtin",
        "capture" => "capture",
        "capture-s3" => "capture-s3",
        _ => anyhow::bail!("unknown benchmark variant"),
    };
    let count: usize = env::var("BENCH_COMMITS")
        .unwrap_or_else(|_| "500".into())
        .parse()?;
    let warmup: usize = env::var("BENCH_WARMUP")
        .unwrap_or_else(|_| "100".into())
        .parse()?;
    let flow_count: usize = env::var("BENCH_FLOWS")
        .unwrap_or_else(|_| "64".into())
        .parse()?;
    let blob_bytes: usize = env::var("BENCH_BLOB_BYTES")
        .unwrap_or_else(|_| "4096".into())
        .parse()?;
    ensure!(
        count > 0 && flow_count > 0,
        "count and flows must be positive"
    );
    let output = PathBuf::from(env::var("BENCH_OUTPUT")?);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    s3::set_retries(0);
    let bucket = if variant == "capture-s3" {
        let credentials = Credentials::new(
            Some(&env::var("AWS_ACCESS_KEY_ID")?),
            Some(&env::var("AWS_SECRET_ACCESS_KEY")?),
            None,
            None,
            None,
        )?;
        Some(
            Bucket::new(
                &env::var("S3_BUCKET")?,
                Region::Custom {
                    region: "us-east-1".into(),
                    endpoint: env::var("S3_ENDPOINT")?,
                },
                credentials,
            )?
            .with_path_style(),
        )
    } else {
        None
    };
    let blob: Vec<u8> = (0..blob_bytes).map(|n| (n % 251) as u8).collect();
    let checksum = hash(&blob);
    let flow_ids: Vec<_> = (0..flow_count).map(|i| format!("flow-{i:06}")).collect();
    let initial = fs::read(env::var("BENCH_SEED_IMAGE")?)?;
    let initial_sha384 = hash(&initial);
    let initial_bytes = initial.len();
    let mut state = State::from_image(initial)?;
    let mut samples = Vec::with_capacity(count);
    for index in 0..(warmup + count) {
        let flow = flow_ids[index % flow_count].clone();
        let viewpoint = (index / flow_count + 1).to_string();
        let milestone = (index + 2).to_string();
        let markers = BTreeMap::from([(
            flow,
            Marker {
                viewpoint,
                sha384: checksum.clone(),
                blob: blob.clone(),
            },
        )]);
        let started = Instant::now();
        let mut boundary = started;
        let mut phases = BTreeMap::new();
        let mut observed = |name: &str| {
            let now = Instant::now();
            phases.insert(
                name.to_owned(),
                now.duration_since(boundary).as_secs_f64() * 1e6,
            );
            boundary = now;
        };
        for marker in markers.values() {
            marker.validate()?;
        }
        observed("marker_validate");
        let (next, event_bytes) = if variant == "builtin" {
            let native = Native::open_with_capture(&state.image, None, false)?;
            observed("open_copy");
            State::transact(&native, &milestone, &markers)?;
            observed("transaction");
            native.checkpoint()?;
            observed("checkpoint");
            let image = native.image()?;
            observed("image_read");
            (State { native, image }, 0)
        } else {
            let (next, delta) = state.stage_observed(&milestone, &markers, false, &mut observed)?;
            let command = event::CommitFlow {
                markers,
                deltas: event::Deltas {
                    turso: BTreeMap::from([(ID.into(), delta)]),
                },
            };
            let bytes = event::encode(command)?;
            observed("event_encode");
            if let Some(bucket) = &bucket {
                let key = diffuse16::key(&num_bigint::BigUint::from(index + 2))?;
                let response = runtime.block_on(bucket.put_object_with_headers(
                    &key,
                    &bytes,
                    Some(axum::http::HeaderMap::from_iter([(
                        axum::http::header::IF_NONE_MATCH,
                        axum::http::HeaderValue::from_static("*"),
                    )])),
                ))?;
                ensure!(
                    (200..300).contains(&response.status_code()),
                    "S3 PUT returned {}",
                    response.status_code()
                );
                observed("s3_put");
            }
            (next, bytes.len())
        };
        state = next;
        observed("publish_drop");
        let total_us = started.elapsed().as_secs_f64() * 1e6;
        if index >= warmup {
            samples.push(Sample {
                variant,
                milestone: index + 2,
                total_us,
                phases_us: phases,
                database_bytes: state.image.len(),
                event_bytes,
            });
        }
    }
    ensure!(
        state.milestone()? == (warmup + count + 1).to_string(),
        "incorrect final Milestone"
    );
    let flows = state.flows()?;
    ensure!(flows.len() == flow_count, "incorrect final Flow count");
    for (i, flow) in flow_ids.iter().enumerate() {
        let expected = if i < warmup + count {
            (warmup + count - 1 - i) / flow_count + 1
        } else {
            0
        };
        ensure!(
            flows[flow].decimal() == expected.to_string(),
            "incorrect Viewpoint for {flow}"
        );
    }
    ensure!(
        state.native.conn.pragma_query("integrity_check")? == vec![vec![Value::build_text("ok")]],
        "database integrity failure"
    );
    if let Some(bucket) = &bucket {
        let last = runtime.block_on(bucket.get_object(diffuse16::key(
            &num_bigint::BigUint::from(warmup + count + 1),
        )?))?;
        ensure!(last.status_code() == 200, "missing final event");
        let command = event::decode(last.as_slice())?;
        ensure!(
            command.deltas.turso[ID].physical.after == hash(&state.image),
            "S3 event disagrees with database"
        );
    }
    fs::write(
        output,
        serde_json::to_vec(&serde_json::json!({
            "schema": 1, "variant": variant, "turso_version": VERSION,
            "commits": count, "warmup": warmup, "flows": flow_count, "blob_bytes": blob_bytes,
            "initial_database_bytes": initial_bytes, "initial_database_sha384": initial_sha384,
            "samples": samples,
        }))?,
    )?;
    Ok(())
}

#[test]
#[ignore = "benchmark fixture generation"]
fn seed() -> Result<()> {
    let flow_count: usize = env::var("BENCH_FLOWS")?.parse()?;
    let state = State::genesis()?;
    let markers: BTreeMap<_, _> = (0..flow_count)
        .map(|i| {
            (
                format!("flow-{i:06}"),
                Marker {
                    viewpoint: "0".into(),
                    sha384: hash(&[]),
                    blob: vec![],
                },
            )
        })
        .collect();
    let (state, delta) = state.stage("1", &markers, true)?;
    fs::write(env::var("BENCH_SEED_IMAGE")?, &state.image)?;
    let command = event::CommitFlow {
        markers,
        deltas: event::Deltas {
            turso: BTreeMap::from([(ID.into(), delta)]),
        },
    };
    fs::write(env::var("BENCH_SEED_EVENT")?, event::encode(command)?)?;
    Ok(())
}

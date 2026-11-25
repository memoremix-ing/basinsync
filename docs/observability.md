[metric]: <glossary/metric.md>
[tracing]: <glossary/tracing.md>

# Observability

Use `RUST_LOG` to filter *tracing*[~][tracing] output; the default is
`basinsync=info`. `BASINSYNC_LOG_FORMAT=text|json` selects the representation,
defaulting to `json`. API responses include a generated `x-request-id`.
Correlate it with `request_id`, `batch_id`, and the recorded positions.

`GET /metrics` on the server listener exposes process-local *Prometheus
metrics*[~][metric]. Counters reset at restart; durable queue counts are
resampled from recovered state, approximately once per second.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `basinsync_http_total`, `basinsync_http_seconds` | `operation`, `status` | HTTP outcomes and handler latency |
| `basinsync_stage_seconds`, `basinsync_stage_total` | `stage`, `operation`, `outcome` | Processing-stage latency and completion outcomes |
| `basinsync_http_inflight` | `operation` | Active handlers |
| `basinsync_stage_inflight` | `stage`, `operation` | Active stages |
| `basinsync_requests_queued`, `basinsync_submissions_inflight` | `operation` | Requests awaiting preparation or a durable result |
| `basinsync_submissions_total` | `operation`, `outcome` | `ok`, `rejected`, `failed`, or `abandoned` durable-result handling |
| `basinsync_batches_queued`, `basinsync_batches_publishing` | none | Prepared-batch pressure |
| `basinsync_batches_total` | `operation`, `outcome` | Prepared-batch outcomes |
| `basinsync_background_pending`, `basinsync_background_oldest_age_seconds` | `space`, `queue` | Durable sweeping, marking, freed-node, and promotion queues |
| `basinsync_background_sample_timestamp_seconds` | none | Freshness of the last successful queue sample |
| `basinsync_s3_copy_total` | `status` | COPY attempts; destination verification determines promotion success |
| `basinsync_analogue_buffer_bytes` | none | Archive buffering |
| `basinsync_last_success_timestamp_seconds` | `operation` | Last local Timeline, backup, or archive publication |

Stages include `admission`, `prepare`, `publish` (operation `timeline`, once per
Timeline PUT), and `acknowledgement`, which times each submission from admission
to its durable result.

`operation` names the request or batch kind, such as `commit`, `reserve`,
`status`, `kernel`, `promotion`, or `cleanup`; `outcome` uses the
durable-result values above.

Histograms expose `_bucket`, `_sum`, and `_count`. Queue wait runs from submission
to preparation; acknowledgement latency runs from submission to the durable
result, excluding body parsing. HTTP latency includes the handler's earlier work.
HTTP cancellation and durable completion are independent: disconnected clients'
accepted work can still succeed, and its `outcome` still reports that durable
result. `abandoned` counts only submissions dropped before any durable result.

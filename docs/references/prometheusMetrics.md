# overlay-blueprints Prometheus Metrics Reference

Every series is `overlay_host_*`, served at `GET /metrics` on the host's HTTP
listener. The engine exposes no registry, so every series is counted by the
host itself and rendered as bare Prometheus text (no `# HELP` / `# TYPE` lines,
no runtime or process metrics). Counters with a known label set are preset at
zero so an absent event still matches in `rate()`.

## Metric types

| Type | Description |
|------|-------------|
| Counter | Monotonic; only increases or resets to zero on restart. Always suffixed `_total`. |
| Gauge | A value read at scrape time. |
| Info | Constant 1; the labels are the payload. |

## Metrics

| Name | Type | Labels | Meaning |
|------|------|--------|---------|
| `overlay_host_build_info` | Info | `overlay_pkg`, `overlay`, `sdk`, `gasp`, `node` | Installed engine package and version, `@bsv/sdk`, `@bsv/gasp` and Node versions. |
| `overlay_host_ready` | Gauge | none | 1 when the last readiness check (storage and chain tracker) passed. |
| `overlay_host_indexed_outputs` | Gauge | none | Outputs held in the host's lookup index. |
| `overlay_host_submits_total` | Counter | `result` = `ok`, `malformed`, `error` | `POST /submit` requests. |
| `overlay_host_topic_submits_total` | Counter | `topic` | Accepted submissions per requested topic. |
| `overlay_host_admissions_total` | Counter | `topic` | Outputs admitted per topic (from the STEAK). |
| `overlay_host_topic_failures_total` | Counter | `topic` | Topic admissions that failed inside the engine. Preset per configured topic. |
| `overlay_host_proof_ingests_total` | Counter | `result` = `upgraded`, `already`, `no-proof`, `unverified`, `unknown`, `error` | Merkle paths on resubmitted transactions, verified against the host's headers. |
| `overlay_host_lookups_total` | Counter | `result` = `ok`, `malformed`, `error` | `POST /lookup` requests (BRC-24). |
| `overlay_host_gasp_served_total` | Counter | `result` = `ok`, `malformed`, `unknown-topic`, `error` | GASP requests served to peers (`/requestSyncResponse`, `/requestForeignGASPNode`). |
| `overlay_host_gasp_syncs_total` | Counter | `result` = `ok`, `no-peers`, `peer-error`, `error` | `POST /admin/startGASPSync` runs. `no-peers` means nothing was done. |

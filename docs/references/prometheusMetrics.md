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
| `overlay_host_build_info` | Info | `version` (this host's release), `overlay_pkg`, `overlay`, `sdk`, `gasp`, `node` | Installed engine package and version, `@bsv/sdk`, `@bsv/gasp` and Node versions. |
| `overlay_host_ready` | Gauge | none | 1 when the last readiness check (storage and chain tracker) passed. |
| `overlay_host_indexed_outputs` | Gauge | none | Unspent output rows on the configured topics, counted from storage once a minute (an outpoint held on two topics counts twice). |
| `overlay_host_submits_total` | Counter | `result` = `ok`, `malformed`, `error` | `POST /submit` requests. |
| `overlay_host_topic_submits_total` | Counter | `topic` | Accepted submissions per requested topic. |
| `overlay_host_admissions_total` | Counter | `topic` | Outputs admitted per topic (from the STEAK). |
| `overlay_host_topic_failures_total` | Counter | `topic` | Topic admissions that failed inside the engine. Preset per configured topic. |
| `overlay_host_proof_ingests_total` | Counter | `result` = `upgraded`, `replaced`, `already`, `no-proof`, `unverified`, `unknown`, `error` | Merkle paths on resubmitted transactions, verified against the host's headers. `replaced`: the stored path no longer verified (its block left the best chain) and the submitted one does. |
| `overlay_host_lookups_total` | Counter | `result` = `ok`, `malformed`, `error` | `POST /lookup` requests (BRC-24). |
| `overlay_host_gasp_served_total` | Counter | `result` = `ok`, `malformed`, `unknown-topic`, `error` | GASP requests served to peers (`/requestSyncResponse`, `/requestForeignGASPNode`). |
| `overlay_host_gasp_syncs_total` | Counter | `result` = `ok`, `no-peers`, `peer-error`, `error` | `POST /admin/startGASPSync` runs. `no-peers` means nothing was done. |
| `overlay_host_reorg_blocks_total` | Counter | none | Blocks holding this host's proven admissions found to have left the best chain. |
| `overlay_host_reorg_demoted_total` | Counter | none | Admissions demoted to unproven because their block left the best chain. |
| `overlay_host_verify_workers` | Gauge | none | Script verification worker threads (0: verified inline). |
| `overlay_host_verify_in_flight` | Gauge | none | Transactions sent to the workers and not yet answered. |
| `overlay_host_verified_in_workers_total` | Counter | none | Transactions whose scripts a worker verified. |
| `overlay_host_verify_duration_seconds` | Histogram | `path` (`worker`, `inline`, `bridge`), `result` (`ok`, `refused`, `error`) | Script verification per transaction, end to end including queueing in the pool; buckets 0.1 ms to 100 ms. `path="bridge"` is a check SKIPPED because the bridge ran it (the duration is the skip's cost): read the engine's own latency with `path=~"worker\|inline"`. |
| `overlay_host_verify_skipped_total` | Counter | none | Script checks skipped on an accepted bridge marker. |
| `overlay_host_bridge_marker_total` | Counter | `result` (`accepted`, `disabled`, `not_loopback`, `bad_mac`) | Bridge SPV markers seen on `/submit`. Anything but `accepted` was ignored and the object verified in full. Preset at zero. |
| `overlay_host_verify_refused_total` | Counter | `path` | Transactions whose scripts verified false. |

# Configuration

Every setting is an environment variable, and the ones that carry secrets
arrive through an `EnvironmentFile=` on the host: mode 0600, owned by the
service user, and referenced by the unit. These hosts are built out of band
and never converged, so there is no fleet secret mechanism to inherit, and
nothing sensitive is written into this repository.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERLAY_TOPICS` | none, required | Comma list of topic names to mount. The host mounts no topics without it |
| `OVERLAY_KNEX_URL` | none, required | MySQL connection string for the engine's storage, for example `mysql://user:pass@host:3306/overlay`. MySQL only: the engine's migrations branch on the client, so a development host runs the same client a deployed one does |
| `OVERLAY_CHAIN_TRACKER_URL` | none, required | The bridge's header read API. **Deliberately not defaulted**: a default would quietly send this host's verification questions to a third party |
| `OVERLAY_ADMIN_TOKEN` | none, required | Bearer token for `/admin/*`. Not defaulted, because the admin surface can trigger catch-up and an unauthenticated one is not a thing to make easy to leave off |
| `OVERLAY_LISTEN` | `0.0.0.0` | Listen address |
| `OVERLAY_PORT` | `8080` | Listen port |
| `OVERLAY_SYNC_PEERS` | empty | Catch-up peers, `topic=url[,url][;topic=url]`. Empty means this host never syncs with anyone, and the admin catch-up route is then a no-op that reports itself as one. Every URL must be http or https and every topic must be one this host mounts; a malformed entry stops startup rather than being dropped |
| `OVERLAY_LOG_TIME` | `false` | Engine timing logs |

A missing or malformed required value stops the process before the port opens,
with a one-line message and exit code 2. It is not a stack trace: a
misconfiguration is not a crash.

## Startup assertions

Three configurations would otherwise look healthy and be wrong, so the host
refuses to start on each:

- **No chain tracker.** The engine would verify against nothing.
- **A topic configured twice.** `managers` and `lookupServices` are plain
  objects keyed by topic name, so a duplicate silently keeps the last value
  with no error at all.
- **A topic with no manager**, or a manager mounted for a topic that is not
  configured.

## Catch-up

`POST /admin/startGASPSync` drives the engine's catch-up. What it does depends
entirely on `OVERLAY_SYNC_PEERS`, and the failure mode is silence rather than
an error: the engine skips every topic whose sync configuration is `false`, so
on a host with no peers configured the route returns 200 having done nothing.

It reports `{"status":"no-peers"}` and counts
`overlay_host_gasp_syncs_total{result="no-peers"}` in that case, and the host
says so once at startup. This is spelled out because a 200 and a success
counter were once read as proof that catch-up worked. They prove the bearer
check works.

## Readiness

`/readyz` gates on storage answering and the chain tracker answering,
re-checked every ten seconds rather than cached: a host that came up healthy
and then lost its chain tracker is not ready and should say so.

## Development

`compose.yaml` brings up MySQL and the host together. It carries a throwaway
password in plain sight, which is the point: it is a development file, it is
never the source of a deployed value, and a reader should not have to wonder
whether a credential in this repository is real.

```sh
OVERLAY_CHAIN_TRACKER_URL=http://your-bridge:9178 docker compose up --build
```

The chain tracker URL is the one value compose cannot invent, for the reason
in the table above, so it is passed in rather than defaulted. Without it
compose aborts before starting anything, which is the intended behaviour and
not a broken file.

## Running a stock server instead

This host is propagation route 1. The other supported posture is a stock
`overlay-express` server with `configureEngineParams({ slapTrackers: [],
shipTrackers: [], advertiser })`. Two things to know before choosing it:

- It is **not quiet**. Its propagation step runs, resolves no peer, and
  records that failure on every submission that admits an output. Do not
  alert on host-side engine errors during such a run.
- It needs **MongoDB to report itself ready**, not to work. `configureEngine(false)`
  removes the need for Mongo to start, but the shipped health check then
  answers 503 on `/health/ready` for ever. Engine storage is knex either way;
  Mongo is only the discovery and ban store.

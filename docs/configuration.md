# Configuration

Every setting is an environment variable. The ones that carry secrets belong
in an `EnvironmentFile=` on the host (mode 0600, owned by the service user),
never in a repository.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERLAY_TOPICS` | none, required | Comma list of topic names to mount. The host mounts no topics without it |
| `OVERLAY_KNEX_URL` | none, required | MySQL connection string for the engine's storage, for example `mysql://user:pass@host:3306/overlay`. MySQL only: the engine's migrations branch on the client, so a development host runs the same client a deployed one does |
| `OVERLAY_CHAIN_TRACKER_URL` | none, required | The header source: a bridge's header read API URL, `woc:main` or `woc:test` (the public WhatsOnChain API), or `chaintracks:https://host/v2` (a chaintracks v2 service). Every header a WhatsOnChain or chaintracks source answers is hashed and must carry the work its bits claim, at or above the network floor on mainnet, so such a source cannot lie without mining a block. **Deliberately not defaulted**: a default would quietly send this host's verification questions to a third party |
| `OVERLAY_CHAIN_NETWORK` | the source's own | `main`, `test` or `regtest`: the network a WhatsOnChain or chaintracks source is checked against. `main` requires a difficulty of at least 4e9; the others check each header against its own target |
| `OVERLAY_ADMIN_TOKEN` | none, required | Bearer token for `/admin/*`. Not defaulted, because the admin surface can trigger catch-up and an unauthenticated one is not a thing to make easy to leave off |
| `OVERLAY_LISTEN` | `0.0.0.0` | Listen address |
| `OVERLAY_PORT` | `8080` | Listen port |
| `OVERLAY_SYNC_PEERS` | empty | Catch-up peers, `topic=url[,url][;topic=url]`. Empty means this host never syncs with anyone, and the admin catch-up route is then a no-op that reports itself as one. Every URL must be http or https and every topic must be one this host mounts; a malformed entry stops startup rather than being dropped |
| `OVERLAY_MAX_LOOKUP_RESULTS` | engine default | Cap on the outputs one lookup answers. `-1` is unbounded, which a public host should not choose; anything else must be a positive integer |
| `OVERLAY_LOG_TIME` | `false` | Engine timing logs |
| `OVERLAY_MODULES` | empty | Comma list of absolute paths to host-side modules (compiled ES modules). Each must name topics `OVERLAY_TOPICS` already names, and its manager replaces `tm_anytx` on them. A malformed entry, a relative path, an unknown topic or a duplicate lookup name stops startup rather than being dropped. See [Modules](#modules) |

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

## Modules

The host mounts `tm_anytx` on every configured topic and `ls_anytx` beside
it, and knows nothing else about any topic. An application that needs a real
topic manager, one that decides what belongs in its topic, lives in its own
repository and is loaded here by path:

```sh
OVERLAY_TOPICS=tm_anytx,tm_example
OVERLAY_MODULES=/opt/overlay/modules/example/index.js
```

A module is a compiled ES module whose default export is a factory:

```ts
export default function create(host: ModuleHost): Module | Promise<Module>

interface ModuleHost {
  log: (msg: string, extra?: Record<string, unknown>) => void
  metrics: {
    inc: (name: string, labels?: Record<string, string>, by?: number) => void
    preset: (name: string, labels?: Record<string, string>) => void
    gauge: (name: string, fn: () => number) => void
  }
}

interface RestoreStorage {
  findOutput: (txid: string, outputIndex: number, topic?: string) => Promise<Output | null>
}

interface Module {
  topics?: Record<string, TopicManager>
  lookups?: Record<
    string,
    LookupService & { restore?: (outputs: Output[], storage: RestoreStorage) => number | Promise<number> }
  >
}
```

The rules, each enforced before the port opens and each a startup refusal
with the module's path in the message:

- Every topic a module mounts must already be named in `OVERLAY_TOPICS`, so
  the environment alone says which topics a host carries. The module's
  manager then **replaces** `tm_anytx` on that topic. Topics no module claims
  keep `tm_anytx`.
- Two modules may not mount the same topic.
- A lookup name must be new: not `ls_anytx`, not one another module mounted.
  The engine keys both maps by name and a duplicate would silently keep the
  last value.
- A module that mounts nothing is refused.

A module's lookup service may offer `restore(outputs, storage)`. The engine
does not replay past admissions into a lookup service on start, so an
in-memory index comes back empty after every restart without it. The host
calls it before the port opens with the unspent outputs of the topics that
**same module** declares (`outputScript` included, so an index can be rebuilt
by parsing each script; `outputsConsumed` too, so an output's retained
inputs are known) and with its storage, awaits the result whether or not it
is a promise, and logs the count it returned. `storage.findOutput` is the
engine's own: it answers for spent outputs as well, with `spent` and
`consumedBy`, so a service whose objects are retracted when an output they
spend is spent again can rebuild that retraction rather than lose it on
restart.

The host resolves the module by `import()` of its absolute path, so the
module's own bare-specifier imports (for example `@bsv/sdk`) resolve from the
nearest `node_modules` above the module file. Placing the compiled module
inside the host's tree, beside its `node_modules`, is what makes a module
share the host's SDK copy rather than carry a second one.

Metrics a module counts through `host.metrics` render on `/metrics` beside the
host's own. Preset every series a module will increment, for the reason the
host presets its own: a counter absent until its first event reads as healthy.

## Catch-up

`POST /admin/startGASPSync` drives the engine's catch-up. What it does depends
entirely on `OVERLAY_SYNC_PEERS`, and the failure mode is silence rather than
an error: the engine skips every topic whose sync configuration is `false`, so
on a host with no peers configured the route returns 200 having done nothing.

It reports `{"status":"no-peers"}` and counts
`overlay_host_gasp_syncs_total{result="no-peers"}` in that case, and the host
says so once at startup. A 200 from this route on such a host proves the bearer
check and nothing else. A peer that fails answers `{"status":"peer-error"}`
with a 502, because the engine logs per-peer errors and carries on, so its own
return value says nothing about whether anything synced.

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
compose aborts before starting anything, which is the intended behavior and
not a broken file.

## Running a stock server instead

The other supported posture is a stock `overlay-express` server with
`configureEngineParams({ slapTrackers: [], shipTrackers: [], advertiser })`.
Two things to know before choosing it:

- It is **not quiet**. Its propagation step runs, resolves no peer, and
  records that failure on every submission that admits an output. Do not
  alert on host-side engine errors during such a run.
- It needs **MongoDB to report itself ready**, not to work. `configureEngine(false)`
  removes the need for Mongo to start, but the shipped health check then
  answers 503 on `/health/ready` for ever. Engine storage is knex either way;
  Mongo is only the discovery and ban store.

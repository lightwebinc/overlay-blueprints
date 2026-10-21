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
| `OVERLAY_REORG_DEPTH` | `10` | Blocks below the tip whose proofs the reorg watch re-checks; `0` turns it off. See [Reorganizations](#reorganizations) |
| `OVERLAY_REORG_POLL_SECONDS` | `30` | Seconds between reorg checks |
| `OVERLAY_VERIFY_WORKERS` | `2` (`1` on two cores, `0` on one) | Worker threads that verify scripts off the engine's thread; `0` verifies inline. See [scaling](scaling.md) |

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
  chainTracker: ChainTracker            // the headers the engine verifies against
  storage: RestoreStorage               // the engine's storage
  engine: {
    submit: (beef: number[], topics: readonly string[]) => Promise<STEAK>
    evict: (txid: string, options?: { topic?: string; reason?: string }) =>
      Promise<{ evictedTransactions: number; evictedOutputs: number }>
  }
  route: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void
  onReorg: (listener: (e: ReorgEvent) => void | Promise<void>) => void
  onShutdown: (listener: () => void | Promise<void>) => void
}

interface RestoreStorage {
  findOutput: (txid: string, outputIndex: number, topic?: string, spent?: boolean, includeBEEF?: boolean) => Promise<Output | null>
  findOutputsForTransaction?: (txid: string, includeBEEF?: boolean) => Promise<Output[]>
  deleteOutput?: (txid: string, outputIndex: number, topic: string) => Promise<void>
  deleteAppliedTransaction?: (txid: string, topic: string) => Promise<void>
}

interface ReorgEvent {
  tip: number
  disconnected: Array<{ height: number; merkleRoot: string }>
  demoted: Array<{ txid: string; topic: string; height: number }>
}

interface Module {
  topics?: Record<string, TopicManager>
  lookups?: Record<string, LookupService & {
    restore?: (outputs: Output[], storage: RestoreStorage) => number | Promise<number>
    restoreFrom?: (outputs: AsyncIterable<Output>, storage: RestoreStorage) => Promise<number>
  }>
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
- A route must be `/<lookup>/<name>` for a lookup the same module mounts,
  and may be mounted once.

### Restore

The engine does not replay past admissions into a lookup service on start,
so an in-memory index comes back empty after every restart unless the
service rebuilds it. The host calls one of two methods before the port
opens, with the unspent outputs of the topics that **same module** declares,
in admission order, each with `outputScript`, `outputsConsumed` and its
BEEF, and with its storage, and logs the count returned:

- `restoreFrom(outputs, storage)` is handed the outputs one at a time,
  read from storage a page at a time, so the host holds one page however
  large the topics are. Prefer it for a topic that grows.
- `restore(outputs, storage)` is handed every output in one array. The host
  reads them a page at a time and keeps each BEEF as bytes until it is read,
  but the array grows with the topics.

A service with both is called through `restoreFrom`. `storage.findOutput` is
the engine's own: it answers for spent outputs as well, with `spent` and
`consumedBy`, so a service whose objects are retracted when an output they
spend is spent again can rebuild that retraction rather than lose it on
restart. `deleteOutput` and `deleteAppliedTransaction` drop what a module no
longer keeps without telling any lookup service; `engine.evict` does the same
and tells every lookup service `outputEvicted`.

`ls_anytx` has no restore: it answers from storage at question time, so a
host starts in constant time and memory however many outputs it holds.

### What a module may ask of the host

- `chainTracker` is the host's own header source, so a module that checks a
  proof the engine does not (an ancestor's, a payment's) needs no second
  header configuration.
- `engine.submit` submits a BEEF to this host's topics exactly as `POST
  /submit` does, counted the same and with a carried proof ingested. It is
  for a module that keeps an object refused for now (its block not yet in
  the headers) and offers it again.
- `engine.evict` is the engine's `evictAppliedTransaction`: the outputs of a
  transaction on a topic (or every topic) are deleted, every lookup service
  is told, and the record of the admission goes, so the same object offered
  again is decided afresh.

  Both work once the host has started (after every restore) and throw
  before. Neither may be awaited inside an engine callback (a topic
  manager's `identifyAdmissibleOutputs`, a lookup service's
  `outputAdmittedByTopic`): the engine is part way through a submission
  there.
- `route(path, handler)` serves `handler` for every method at `path` and
  below it on the host's own listener, after the host's routes. The handler
  reads the body and owns the response, so it may stream (a `watch` stream
  at `/ls_bchat/watch`). A route that must sit at an origin's root, such as a
  BRC-104 handshake at `/.well-known/auth`, cannot be mounted: it still needs
  the module's own listener.
- `onReorg(listener)` is called after blocks this host holds proven
  admissions in leave the best chain, and after those admissions are demoted
  to unproven (see [Reorganizations](#reorganizations)).
- `onShutdown(listener)` is called once when the host is asked to stop,
  before its listener closes and its database is released; each listener is
  awaited for at most five seconds.

The host resolves the module by `import()` of its absolute path, so the
module's own bare-specifier imports (for example `@bsv/sdk`) resolve from the
nearest `node_modules` above the module file. Placing the compiled module
inside the host's tree, beside its `node_modules`, is what makes a module
share the host's SDK copy rather than carry a second one.

Metrics a module counts through `host.metrics` render on `/metrics` beside the
host's own. Preset every series a module will increment, for the reason the
host presets its own: a counter absent until its first event reads as healthy.

## Proofs

A transaction the host already holds, submitted again with a merkle path, has
that path checked against this host's own headers before anything is
written:

- held unproven, the path is ingested (`result="upgraded"`);
- held with a path that still verifies, nothing is written (`already`);
- held with a path that no longer verifies, because its block left the best
  chain and the transaction was mined again elsewhere, the submitted path
  replaces it (`replaced`). The stored path is checked against the header
  source itself, never a cached answer, so a valid stored proof is never
  displaced.

## Reorganizations

The engine records the height and merkle root of every proven admission.
Every `OVERLAY_REORG_POLL_SECONDS` the host asks its header source, afresh,
whether each distinct height and root of the last `OVERLAY_REORG_DEPTH`
blocks is still the best chain's. For one that is not, every admission proven
in that block is demoted to unproven in the engine's records, the counts go
to `overlay_host_reorg_blocks_total` and `overlay_host_reorg_demoted_total`,
and the modules' `onReorg` listeners are told the blocks and the
admissions. The stored BEEF keeps its old path until a new one arrives (a
mined transaction's BEEF carries no ancestry to fall back on), and the new
one replaces it as above.

A height above the source's own tip, or a source that fails, is not read as
a reorganization. A block deeper than `OVERLAY_REORG_DEPTH` when it left, or
one that held none of this host's proven admissions, is not seen.

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

## Header questions

The engine asks for the tip on every admitted topic and for a root on every
proven transaction in a BEEF. The host answers a repeated tip for one second
and a root found valid for thirty seconds from memory; a root the source did
not know is never remembered. Readiness, the reorg watch and the check of a
stored proof always ask the source.

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

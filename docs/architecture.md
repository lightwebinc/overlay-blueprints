# Architecture

overlay-blueprints is a generic, network-side overlay services host. It runs
the BSV overlay engine as a library, takes objects from the BEEF object plane
of [BSV Layered Multicast](https://github.com/lightwebinc/bsv-multicast), and
carries no application of its own. Applications are modules it loads.

```text
   fabric ══push══▶ overlay-bridge ──▶ POST /submit ──┐
                          │                           ▼
                          │                  ┌─────────────────┐
                          │                  │  HTTP surface   │  /submit /lookup /admin/*
                          │                  │  (src/http.ts)  │  /healthz /readyz /metrics
                          │                  └────────┬────────┘
                          │                           ▼
                          │                  ┌─────────────────┐
                          │                  │ overlay engine  │  topic managers, lookup services
                          │                  │ (no advertiser) │  (tm_anytx/ls_anytx or modules)
                          │                  └──┬───────────┬──┘
                          │                     ▼           ▼
                          └── header store ◀─ chain      KnexStorage
                                              tracker     (MySQL)
```

## Components

| File | Role |
| --- | --- |
| `src/index.ts` | startup: configuration, storage migrations, module loading, lookup index restore, then the port opens |
| `src/config.ts` | every setting from the environment; a bad value exits with code 2 before the port opens |
| `src/engine.ts` | assembles the engine with no advertiser and empty SHIP/SLAP tracker lists |
| `src/storage.ts` | the engine's own `KnexStorage` on MySQL |
| `src/chaintracker.ts`, `src/headersource.ts` | the chain tracker: a bridge's header API, WhatsOnChain (`woc:main`, `woc:test`) or chaintracks; third-party headers are checked for proof of work |
| `src/proofs.ts` | upgrades a stored unproven transaction when it is resubmitted with a merkle path that verifies against this host's headers |
| `src/modules.ts` | loads `OVERLAY_MODULES` and enforces the module rules |
| `src/topics/anytx.ts`, `src/lookup/anytx.ts` | `tm_anytx` and `ls_anytx`: the default, application-free pair that admits every output and answers by outpoint |
| `src/metrics.ts`, `src/buildinfo.ts` | Prometheus text on `/metrics`, with every series preset at zero |

## Request flow

1. The bridge (or any BRC-22 client) posts a BEEF to `/submit` with an
   `x-topics` header.
2. The engine runs each named topic's manager. Admitted outputs are stored;
   merkle paths are verified through the chain tracker.
3. The answer is a STEAK. A topic that failed validation is counted
   (`overlay_host_topic_failures_total`) rather than lost in a 200.
4. `/lookup` (BRC-24) asks a lookup service for a formula; the engine
   hydrates it into BEEF from storage.

## What the host does not do

- **No propagation.** With no advertiser and no trackers, the engine never
  contacts SHIP/SLAP overlays. The multicast plane is the propagation.
- **No application logic.** `tm_anytx` decides nothing; a real application
  supplies its own topic manager and lookup service as a module, usually in
  an image built `FROM ghcr.io/lightwebinc/overlay-blueprints:<version>`.
- **No implicit peers.** Catch-up (GASP) runs only against peers named in
  `OVERLAY_SYNC_PEERS`.

## Engine fork

The engine is `@bsv/overlay` 2.3.1 with one additive change, an
`onTopicFailed` hook, so the host can tell a failed topic from an empty one.
It is carried as a tarball in `vendor/overlay-fork/`; see
[FORK.md](../vendor/overlay-fork/FORK.md).

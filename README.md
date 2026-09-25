# overlay-blueprints

A reference overlay services host that takes the BEEF object plane as its
transport, and the applications built on it.

```text
   fabric ══push══▶ overlay-bridge ──▶ POST /submit ──▶ this host
                          │                                │
                          └── header store ◀── chain tracker reads
```

## What it is

The released `@bsv/overlay` engine, assembled as a library, with:

- **no advertiser**, so the engine admits and indexes and never propagates.
  The plane is the propagation. This is the quiet posture: the engine skips
  the step outright rather than attempting it and failing.
- **explicitly empty** SHIP and SLAP tracker lists, so nothing ever falls
  back to a public default.
- **its chain tracker pointed at the bridge**, so every object it admits is
  verified against headers the host itself received from the same network
  that delivered the object.
- **`KnexStorage` on MySQL**, which ships inside the engine package. No
  storage backend is written here and none is forked.

## What it is not

It is not a product and not a template for a real overlay. `tm_anytx` admits
every output and decides nothing, because its job is to make two hosts
comparable rather than to model an application. A real topic manager decides
what belongs in its topic. The blueprint applications are separate.

## Surface

| Route | |
| --- | --- |
| `POST /submit` | BRC-22, at the ROOT, octet-stream body, `x-topics` in either wire form. Answers a bare STEAK |
| `POST /lookup` | BRC-24 |
| `POST /admin/startGASPSync` | catch-up from explicitly configured peers, behind a bearer token. A no-op, reported as such, on a host with no peers configured |
| `POST /requestSyncResponse` `POST /requestForeignGASPNode` | the peer side of catch-up, so another host can sync from this one |
| `GET /healthz` `GET /readyz` | liveness, and readiness gated on storage and the chain tracker |
| `GET /metrics` | Prometheus text. The engine exposes none, so everything here is counted by the host |

## Configuration

Entirely from the environment; see [docs/configuration.md](docs/configuration.md).
What the tests and the live runs established is in
[docs/verification.md](docs/verification.md).

Catch-up peers, if any, are named explicitly in `OVERLAY_SYNC_PEERS`. The
engine would also accept `SHIP`, which resolves peers through the public
discovery overlays; this host does not offer it, because reaching those to
find a peer is the outbound behaviour the no-advertiser posture exists to
remove.

## Licence

Apache-2.0 (see `LICENSE`). Dependencies and the attribution their licences
require are in `NOTICE`.

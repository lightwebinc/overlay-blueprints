# overlay-blueprints

[![CI](https://github.com/lightwebinc/overlay-blueprints/actions/workflows/ci.yml/badge.svg)](https://github.com/lightwebinc/overlay-blueprints/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lightwebinc/overlay-blueprints)](https://github.com/lightwebinc/overlay-blueprints/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

> [!WARNING]
> **Experimental software.** overlay-blueprints is the reference overlay host used by
> [bstack](https://github.com/lightwebinc/bstack) applications on
> [BSV Layered Multicast](https://github.com/lightwebinc/bsv-multicast).
> It is published to be built on and improved. Interfaces, formats and behavior may change
> rapidly between releases; pin an exact version.

A reference overlay services host that takes the BEEF object plane as its
transport. It carries no application: applications are host-side modules
loaded at startup (`OVERLAY_MODULES`), and their images build on this one.

```text
   fabric ══push══▶ overlay-bridge ──▶ POST /submit ──▶ this host
                          │                                │
                          └── header store ◀── chain tracker reads
```

## What it is

The released `@bsv/overlay` engine (2.3.1, carried as a one-change fork: see
[FORK.md](vendor/overlay-fork/FORK.md)), assembled as a library, with:

- **no advertiser**, so the engine admits and indexes and never propagates.
  The plane is the propagation. This is the quiet posture: the engine skips
  the step outright rather than attempting it and failing.
- **explicitly empty** SHIP and SLAP tracker lists, so nothing ever falls
  back to a public default.
- **its chain tracker pointed at the bridge**, so every object it admits is
  verified against headers the host itself received from the same network
  that delivered the object. A host with no bridge points it at WhatsOnChain
  or a chaintracks service instead, and checks the proof of work of every
  header those answer (see [configuration](docs/configuration.md)).
- **`KnexStorage` on MySQL**, which ships inside the engine package. No
  storage backend is written here and none is forked.

## What it is not

It is not an application and not a template for one. `tm_anytx` admits
every output and decides nothing, because its job is to make two hosts
comparable rather than to model an application. A real topic manager decides
what belongs in its topic. Applications are separate repositories that load into this host as modules.

## Surface

| Route | |
| --- | --- |
| `POST /submit` | BRC-22, at the ROOT, octet-stream body, `x-topics` in either wire form. Answers a bare STEAK. A transaction the host already holds unproven, resubmitted with its merkle path, has that path verified against this host's own headers and ingested (`overlay_host_proof_ingests_total{result}`) |
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
find a peer is the outbound behavior the no-advertiser posture exists to
remove.

## Install and run

The image is `ghcr.io/lightwebinc/overlay-blueprints:<version>` (linux/amd64
and linux/arm64). It needs a MySQL database and a header source. With no
bridge, use the public WhatsOnChain API, whose every header is checked for
proof of work:

```sh
docker run --rm -p 8080:8080 \
  -e OVERLAY_TOPICS=tm_anytx \
  -e OVERLAY_KNEX_URL=mysql://overlay:secret@db.example:3306/overlay \
  -e OVERLAY_CHAIN_TRACKER_URL=woc:main \
  -e OVERLAY_ADMIN_TOKEN=change-me \
  ghcr.io/lightwebinc/overlay-blueprints:0.2.3
```

From source (Node 24): `npm ci && npm run build && npm start`. More in
[docs/examples.md](docs/examples.md).

## Documentation

| Document | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | components, request flow, what the host does and does not do |
| [docs/configuration.md](docs/configuration.md) | every environment variable, startup assertions, the module contract |
| [docs/examples.md](docs/examples.md) | running, submitting, looking up, catch-up, building an application image |
| [docs/references/prometheusMetrics.md](docs/references/prometheusMetrics.md) | every `overlay_host_*` series, its labels and meaning |
| [docs/verification.md](docs/verification.md) | what the tests and live runs establish, and their limits |
| [vendor/overlay-fork/FORK.md](vendor/overlay-fork/FORK.md) | the one change made to the overlay engine |

Releases and notes live on [GitHub Releases](https://github.com/lightwebinc/overlay-blueprints/releases); there is no CHANGELOG.

## License

Apache-2.0 (see `LICENSE`). Dependencies and the attribution their licenses
require are in `NOTICE` and `LICENSE-THIRD-PARTY`.

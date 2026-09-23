# What has been run, and what that proved

Unit tests cover the parts that can be decided without a database. This file
records the live runs, because the things that went wrong in this work were
never caught by reading source: they were caught by running it. Two claims
about the engine that had been read carefully out of its source turned out to
be false the first time a real engine answered.

## Unit

`npm test`, 10 tests, all passing:

- `parseTopics` accepts both wire forms of `x-topics`, and refuses a list with
  an empty name rather than filtering it. Filtering loses a topic in silence,
  which is worse than a 400.
- The three startup assertions fire: no chain tracker, a topic configured
  twice, a manager without its topic.
- `ls_anytx` answers a sorted formula, forgets a spent output and forgets an
  evicted one.
- `tm_anytx` refuses rather than throws on an object it cannot parse. A throw
  from a topic manager is not a rejection, it is a 500.
- `ls_anytx` rebuilds its index from the engine's own storage at startup and
  skips spent outputs, so a restart does not read as two hosts disagreeing.
- `parseSyncPeers` refuses a malformed peer list rather than filtering it, and
  a topic with no peers is `false`, which the engine skips outright.
- The metrics registry presets its series at zero, so an alert can match a
  counter that has not fired yet. An absent series matches nothing.

## Live

Storage is MySQL 9, the engine's own `KnexStorage`, migrations run at startup
through the in-memory migration source. The chain tracker is the bridge's
header read API. Host started with one topic and no advertiser.

Startup log, in order: `storage migrated`, `engine built with no advertiser:
propagation is off`, `listening ready=true`.

| Exercise | Result |
| --- | --- |
| `GET /readyz` | 200 `{"ready":true}`, after both the database and the chain tracker answered |
| `POST /submit`, `x-topics: tm_anytx` | 200, bare STEAK `{"tm_anytx":{"outputsToAdmit":[0],...}}`. The manager admitted, the engine indexed |
| the same object again, `x-topics` as a JSON array | 200, `outputsToAdmit: []`. Both wire forms parse, and the engine recognised the duplicate itself |
| `x-topics: tm_nope` | 400. A topic this host does not mount is a client error, not a silent no-op |
| no `x-topics` at all | 400 |
| `POST /lookup` `{all:true}` | 200 `output-list`, one output, the BEEF round-tripped byte for byte. The formula was hydrated by the engine |
| `POST /lookup` unknown service | 400 |
| `POST /admin/startGASPSync`, no token | 401 |
| the same, wrong token | 401 |
| the same, right token | 200, and the counter moved |

### Five distinct objects

The first run above admitted one object, which proves the route but not the
index: an engine that admitted everything into one slot would look identical.
So five objects were built, each a transaction whose only output carries a
different nonce, each with its own merkle path at its own height, and each
verified by the host against a header service holding the matching roots.

| Exercise | Result |
| --- | --- |
| five submits, one object each | 200 each, `outputsToAdmit:[0]` each. Five distinct admissions, not one repeated |
| `overlayverify ids` | five sorted `txid.vout` lines, derived from each object's own bytes |
| `overlayverify beef` over the same host | `VERIFIED`, five objects, every BUMP recomputed against an independent header service |

Two things this run settled that no amount of reading would have:

- **The chain tracker is genuinely in the path.** The first attempt was refused
  with `Invalid merkle path`, not because the root was wrong but because the
  objects sat at path index 0, which the SDK treats as the coinbase and refuses
  until the block is 100 deep. Moving them to index 1, with a sibling at 0,
  admitted them. A host that was not really consulting its chain tracker would
  have admitted the first attempt.
- **Roots are compared as display hex**, the same byte order the object's own
  computed root prints in. The little-endian form was tried first and every
  submission was refused.

Honest limit: these objects are locally minted. Their transactions are real and
distinct and their merkle paths verify against the header service the host was
given, but nothing mined them, so this proves the host's admission, indexing
and verification wiring and not provenance. Chain-funded objects are
`txmint overlay`'s work.

### A defect this run found

A restart between the two runs above came back with an **empty** lookup answer
while the engine still held every output. The engine does not replay past
admissions into a lookup service on start, and the index is in memory, so a
restarted host answered an authoritative empty set. Two hosts that agreed
before a restart would have been read as disagreeing after one, which is
exactly the false reading a parity oracle exists to prevent.

Fixed: the host rebuilds the index from `findUTXOsForTopic` before the port
opens, skipping spent outputs, and logs what it restored. Verified by restart:
`lookup index restored from storage outputs=6`, and the oracle answered six.
There is a unit test, and the fix recovered the object the pre-fix restart had
already dropped.

### What that admin run did NOT prove, corrected

The run above was first recorded as proving the authenticated catch-up
trigger. It proves the bearer check and nothing else, and the counter that
looked like evidence was the evidence of the mistake.

Every topic's sync configuration was `false`, and the engine's `startGASPSync`
does `if (configuredEndpoints === false) continue`. So it iterated, skipped
everything, and returned. The route answered 200 and the success counter moved
because a no-op produces both.

Read against source this looked right, because the comment in this repository
said `false` meant "no background sync, admin sync still available". It does
not. It means the topic is skipped on every trigger, including that one.

What changed as a result: catch-up peers are now named explicitly in
`OVERLAY_SYNC_PEERS`, a host with none says so at startup, and the route
answers `{"status":"no-peers"}` with its own counter label instead of
reporting success. A real catch-up between two hosts is still owed, and it
needs the second host, which is the lab phase.

### Re-run after the corrections

Everything above was re-run against the corrected host, on MySQL, and the
counters now distinguish what the old ones conflated.

| Exercise | Result |
| --- | --- |
| three distinct objects, then a fourth submit repeating the first | `overlay_host_topic_submits_total{topic="tm_anytx"} 4` and `overlay_host_admissions_total{topic="tm_anytx"} 3`. The duplicate admitted nothing and is no longer counted as an admission |
| `POST /admin/startGASPSync`, right token, no peers configured | 200 `{"status":"no-peers","topicsWithPeers":0}`, and `overlay_host_gasp_syncs_total{result="no-peers"}` moved. `result="ok"` stayed at 0 |
| startup with no peers | logged `no catch-up peers configured: /admin/startGASPSync will be a no-op` |
| a 100 KB `POST /lookup` body | 413 with `overlay_host_lookups_total{result="malformed"}`. It used to escape the handler, because only `/submit` caught the size throw |
| the parity oracle over the same host | three sorted outpoints, and every merkle proof `VERIFIED` against an independent header service |

### Two hosts, a plane between them, and a recovery

Run 2026-09-22 with the whole stack up: two bridges, two of these hosts, two
MySQL instances, and an edge that writes the same delivery records to both
bridges' object lanes.

| Exercise | Result |
| --- | --- |
| one publish, delivered to both bridges | both bridges submitted 8, both engines admitted 8 |
| `overlayverify ids` on each host | **byte-identical**, 8 outpoints each |
| merkle proofs, checked against an independent header service | `VERIFIED` on both hosts |
| root provenance at the bridges | 16 from the header **lane**, **0 misses**. The engine verified against headers the bridge received itself, not a third party |
| every outbound connection each host held during delivery | **its own MySQL, and nothing else.** No peer, no discovery overlay, nothing off-box |
| positive control for that capture | with a catch-up peer configured, the same per-process check captured the host dialling both its bridge and the peer. So it sees outbound connections when they exist |
| wipe one host's database entirely, then catch up from the peer | **recovered all 8, byte-identical to the peer** |

The recovery is the one worth dwelling on. A host that lost its whole database
rebuilt itself from a peer over the same standards it serves, with no operator
intervention beyond one authenticated call.

### Two defects that run found, both fixed

**The host could ASK for catch-up and could never BE a peer.** It served no
`/requestSyncResponse` or `/requestForeignGASPNode`, so every peer that tried
to sync from it got a 404. Both routes are mounted now.

**And the admin route answered 200 while that failed.** `startGASPSync`
catches every per-peer error, logs it and carries on, so its return value says
nothing about whether anything synced. The route now counts the engine's error
calls and answers `{"status":"peer-error","peerFailures":N}` with a 502.
Measured both ways: `peerFailures: 0` on the recovery above, and
`peer-error` / 502 against a peer that serves no GASP routes.

That is the second time on this host that a success was reported for work that
did not happen, and both had the same shape: a 200 produced by a path that
never ran.

### Tools referred to here

`overlayverify` and `txmint overlay` are not in this repository and are not
public. They are internal tools: a Go parity oracle that reads a host's
`/lookup` answer and verifies every merkle proof against an independent header
service, and a generator that produces funded BEEF objects. They are named
because the evidence above came from them, not as something a reader can run.
Everything under **Unit** above runs from this repository alone.

This is the whole documented surface. What it does not cover is a second host
and a real delivery between them, which is the phase that follows and needs
the lab.

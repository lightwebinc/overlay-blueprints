# What has been run, and what that proved

Unit tests cover the parts that can be decided without a database. This file
records the live runs, because the things that went wrong in this work were
never caught by reading source: they were caught by running it. Two claims
about the engine that had been read carefully out of its source turned out to
be false the first time a real engine answered.

## Unit

`npm test`, 7 tests, all passing:

- `parseTopics` accepts both wire forms of `x-topics`, and refuses a list with
  an empty name rather than filtering it. Filtering loses a topic in silence,
  which is worse than a 400.
- The three startup assertions fire: no chain tracker, a topic configured
  twice, a manager without its topic.
- `ls_anytx` answers a sorted formula, forgets a spent output and forgets an
  evicted one.
- `tm_anytx` refuses rather than throws on an object it cannot parse. A throw
  from a topic manager is not a rejection, it is a 500.
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
| the same, right token | 200, and `overlay_host_gasp_syncs_total{result="ok"}` moved to 1 |

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

This is the whole documented surface. What it does not cover is a second host
and a real delivery between them, which is the phase that follows and needs
the lab.

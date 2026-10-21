# Verification

What the tests cover, what has been run against a live engine, and the limits
of both.

## Unit tests

`npm test` covers what can be decided without a database:

- both `x-topics` wire forms parse, and a list with an empty name is refused
  rather than filtered, because filtering loses a topic in silence;
- the startup refusals fire: no chain tracker, a topic configured twice, a
  manager without its topic;
- `tm_anytx` refuses rather than throws on an object it cannot parse, because
  a throw from a topic manager is a 500, not a rejection;
- `ls_anytx` answers a sorted formula from storage: only unspent rows on
  carried topics, once per outpoint, ordered by the outpoint string, and a
  page after any cursor (real outpoints, prefixes, junk, upper case) is
  exactly the sorted keys after it;
- a stored proof is replaced only when it no longer verifies against the
  header source asked afresh, and the replacement verifies; a source that
  fails replaces nothing;
- the reorg watch demotes the admissions of a block whose root is no longer
  the best chain's, once, and not when the source is behind, fails, or the
  block is deeper than the watch looks;
- scripts verified on the worker pool reach the inline verdict, valid and
  forged alike;
- a module route outside its own lookup names is refused;
- `parseSyncPeers` refuses a malformed peer list, and a topic with no peers
  is `false`, which the engine skips outright;
- every metric series is preset at zero, so an alert can match a counter that
  has not fired yet. An absent series matches nothing.

With `OVERLAY_TEST_KNEX_URL` naming an empty MySQL database, `npm test` also
checks the storage reads against the engine's own `KnexStorage`: `ls_anytx`
against the table model for every cursor, the paged restore against
`findUTXOsForTopic` field for field (score ties across page boundaries
included), and the reorg watch's queries.

## The lab-style check

`node scripts/lab.mjs --modules <dir>` runs the host as a lab host runs it,
with every bstack module bundle found under `<dir>` mounted beside two parity
topics, against a throwaway MySQL and a header source it serves itself. It
admits a load of signed objects, walks `ls_anytx`, refuses a forged
signature, upgrades a proof, moves a block out of the chain and checks the
demotion and the replacing proof, restarts and walks again. A probe module
it writes itself checks what a module is handed: its routes, a submission
through the engine, an eviction and the same object admitted afresh, the
chain tracker, the reorg event and the shutdown listener. With all seven
modules mounted, every check passes.

## Start-up with a large store

A synthetic store shaped like the lab hosts before their nightly prune: 1.39 M
unspent outputs on three parity topics (1.16 M transactions, 1.7 GB of BEEF),
and 150 k on a module topic. Measured on one machine, wall time from launch
to listening and peak resident memory, with the script workers off (each
worker adds about 80 MiB).

| | v0.2.5 | this release |
| --- | --- | --- |
| parity topics only | 14.3 s, 1.5 GiB (18 s at a 1 GiB heap) | 1.0 s, 135 MiB (also at a 128 MiB heap) |
| with a 150 k module topic restored as an array | does not start: the restore's array spread overflows the call stack | 10 s, 700 MiB |
| the same through `restoreFrom` | | 10 s, 290 MiB at a 256 MiB heap |

A page of `{all: true}` (1,000 outpoints, hydrated) took 4 s on v0.2.5, which
sorted the whole index for each page, and 0.4 s here; one outpoint answers in
about 2 ms either way.

## Against a live engine

Run with the engine's own `KnexStorage` on MySQL and the chain tracker pointed
at a bridge's header API. Established:

- `/submit` admits under both `x-topics` wire forms, answers a bare STEAK, and
  recognizes a duplicate itself; an unmounted topic or a missing header is a
  400, not a silent no-op.
- A duplicate that carries a merkle path the host lacked upgrades the stored
  copy, and only after the path verifies against this host's own chain
  tracker. The engine alone drops the proof with the duplicate, so a
  publisher that did not wait for mining would otherwise leave every host
  serving the unproven copy for good. A path naming no block this host knows
  is refused, which is what makes it safe to accept from anyone.
- `/lookup` returns the BEEF byte for byte; an unknown service is a 400 and an
  oversized body is a 413.
- The chain tracker is genuinely in the path: an object whose merkle path sat
  at index 0 was refused, because the SDK treats that position as the
  coinbase until the block is 100 deep. Roots are compared as display hex.
- Two hosts fed by the plane hold byte-identical outputs, every root verified
  against headers each bridge received on its own lane, and each host's only
  outbound connection during delivery is its own database.
- A host whose database was wiped recovered everything from a configured peer
  through `/admin/startGASPSync`, byte-identical to the peer.
- A restart rebuilds the lookup index before the port opens, and a kill
  recorded by a spend survives the restart.

## Limits

The locally minted objects used above have real, distinct transactions and
merkle paths that verify against the header service the host was given, but
nothing mined them, so the runs prove admission, indexing and verification
wiring rather than provenance. And `/admin/startGASPSync` on a host with no
peers configured is a no-op that reports itself as one (`{"status":"no-peers"}`
and a `result="no-peers"` counter): a 200 there proves the bearer check and
nothing else.

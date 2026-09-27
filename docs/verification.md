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
- `ls_anytx` answers a sorted formula, forgets a spent output, and rebuilds
  its index from the engine's own storage at startup, so a restart does not
  read as two hosts disagreeing;
- `parseSyncPeers` refuses a malformed peer list, and a topic with no peers
  is `false`, which the engine skips outright;
- every metric series is preset at zero, so an alert can match a counter that
  has not fired yet. An absent series matches nothing.

## Against a live engine

Run with the engine's own `KnexStorage` on MySQL and the chain tracker pointed
at a bridge's header API. Established:

- `/submit` admits under both `x-topics` wire forms, answers a bare STEAK, and
  recognises a duplicate itself; an unmounted topic or a missing header is a
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

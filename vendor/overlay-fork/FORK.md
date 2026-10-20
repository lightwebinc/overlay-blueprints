# Fork notice

This package is a fork of **`@bsv/overlay` version 2.3.1**, taken from
`bsv-blockchain/ts-stack` at commit `888025a82dcb85f7be9ce091d1075422339fa3cd`
(2026-08-27). It is redistributed under the **Open BSV License Version 6**, the
license of the original, whose full text is carried verbatim in `LICENSE.txt`
inside the package tarball. Copyright in the original work remains with
© BSV Association.

## What was modified

Two changes, both in `src/Engine.ts`, applied in this order by `rebuild.sh`.

### 1. `onTopicFailed` (onTopicFailed.patch)

- an exported `TopicFailureReporter` type,
- an optional public field `Engine.onTopicFailed`,
- a guarded call to it from the existing `catch` in `validateTopicSubmission`
  that already populates `failedTopics`.

Nothing else is altered. No wire format changes, no STEAK shape changes, no
constructor parameter is added or moved, and an engine that never sets
`onTopicFailed` behaves exactly as upstream.

### 2. Atomic BEEF built once per transaction (atomicBEEFOnce.patch)

Admission called `tx.toAtomicBEEF()` once per lookup service per admitted
output, and again for storage compaction and spend notifications, each call
re-walking and re-hashing the whole BEEF. A host with seven mounted modules
spent ~15% of its engine CPU rebuilding the same bytes (measured with
`node --cpu-prof` at its admission ceiling). The engine now keeps a `WeakMap`
from the `Transaction` to its serialized Atomic BEEF, so each transaction is
serialized once; an entry dies with the transaction and is rebuilt if the
transaction's `merklePath` changes. Lookup services receive the same array, and
must treat it as read-only (upstream's own services only parse it). The bytes
are identical to upstream's; only the number of times they are computed
changes.

## Why the onTopicFailed hook

`submit` catches every per-topic validation error into a local `failedTopics`
set and still returns `{outputsToAdmit: [], coinsToRetain: []}` for that topic
with HTTP 200. A topic that FAILED, a topic that was a DUPLICATE and a topic
that legitimately admitted nothing are byte-identical to the caller. A host
admitting nothing therefore looks exactly like a quiet plane, and every counter
built on "did a submit succeed" climbs at full rate while nothing is admitted.

A host that admits nothing is the outage no metric sees, and without this
hook the only mitigation is a slow conjunction of counters rather than an
alert on the first failure.

Matching the engine's log line would need no fork and is exact today, but it
is string matching against a message upstream is free to reword.

## Why a FIELD and not a constructor parameter

The constructor takes twenty positional parameters, and upstream appended
`maxLookupResults` as the twentieth between 2.2.7 and 2.3.1. Position
twenty-one is demonstrably where upstream's next parameter lands, so a fork
claiming it would be silently renumbered by the rebase that adds one, and every
positional caller would then read the wrong argument with no type error at all.
A field costs no position and is how this engine's own tests already inject
`logger`.

## Why forked by NAME and not by version suffix

npm's resolver gives a forked version string no protection, measured rather
than assumed: `2.3.1-lw1` sorts BELOW `2.3.1` and is excluded from `^2.3.1`,
and `2.3.1+lw1` compares EQUAL to upstream with the build suffix stripped. The
package NAME is the only thing the resolver will not quietly step over, so the
fork is `@lightwebinc/overlay` and keeps the upstream version number to say
plainly which release it tracks.

## Upstream

The defect is present unchanged at upstream HEAD (2.6.1), so this delta
survives a rebase and is worth offering upstream.

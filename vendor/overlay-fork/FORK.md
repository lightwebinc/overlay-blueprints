# Fork notice

This package is a fork of **`@bsv/overlay` version 2.3.1**, taken from
`bsv-blockchain/ts-stack` at commit `888025a82dcb85f7be9ce091d1075422339fa3cd`
(2026-08-27). It is redistributed under the **Open BSV License Version 6**, the
licence of the original, whose full text is carried verbatim in `LICENSE.txt`
alongside this file. Copyright in the original work remains with
© BSV Association.

## What was modified

One change, in `src/Engine.ts`:

- an exported `TopicFailureReporter` type,
- an optional public field `Engine.onTopicFailed`,
- a guarded call to it from the existing `catch` in `validateTopicSubmission`
  that already populates `failedTopics`.

Nothing else is altered. No wire format changes, no STEAK shape changes, no
constructor parameter is added or moved, and an engine that never sets
`onTopicFailed` behaves exactly as upstream.

## Why

`submit` catches every per-topic validation error into a local `failedTopics`
set and still returns `{outputsToAdmit: [], coinsToRetain: []}` for that topic
with HTTP 200. A topic that FAILED, a topic that was a DUPLICATE and a topic
that legitimately admitted nothing are byte-identical to the caller. A host
admitting nothing therefore looks exactly like a quiet plane, and every counter
built on "did a submit succeed" climbs at full rate while nothing is admitted.

That is not hypothetical here. A version skew one component earlier caused a
ninety-minute total object-plane outage that no metric could see, and the
mitigation for this engine-side variant can currently only be a twenty-minute
conjunction rather than an alert on the first failure.

The alternative considered and rejected was matching the log line, which is
unconditional and sits immediately before the `failedTopics.add`. It is exact
today and needs no fork. It was rejected because it is string matching against
a message upstream is free to reword, which the consuming host already forbids
itself in writing.

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
survives a rebase and is worth offering upstream. Raising it is an operator
decision under the standing "record, do not raise" ruling.

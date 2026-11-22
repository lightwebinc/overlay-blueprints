# Fork notice

This package is a fork of **`@bsv/overlay` version 2.8.0**, taken from
`bsv-blockchain/ts-stack` at commit `89318cf12a5707539212fee314ded3dbd8df068f`
(2026-11-20). It is redistributed under the **Apache License 2.0**, the license
of the original, whose text, NOTICE and PATENTS files are carried unchanged
inside the package tarball. Copyright in the original work remains with
© BSV Association.

## What was modified

One change, in `src/Engine.ts` (and a test in `src/__tests/Engine.test.ts`),
applied by `rebuild.sh`.

### Atomic BEEF built once per transaction (atomicBEEFOnce.patch)

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

Upstream 2.8.0 still calls `tx.toAtomicBEEF()` directly at each of the three
sites, so the patch is still needed. It is a candidate to offer upstream.

## No longer modified: onTopicFailed

Earlier forks carried an `onTopicFailed` patch. Upstream took it in 2.7.0
(ts-stack#829) with the same shape: an optional public field
`Engine.onTopicFailed`, a `TopicFailureReporter` type, called as
`(topic, error, { txid, mode })` inside a guard so a throwing reporter cannot
change admission. The host assigns the field and uses upstream's unmodified.

It is a field and not a constructor parameter for the reason that held then:
the constructor takes positional parameters and upstream appends new ones
(`scriptVerifier` is now the twenty-first), so a field cannot be renumbered.

## Why forked by NAME and not by version suffix

npm's resolver gives a forked version string no protection, measured rather
than assumed: `2.8.0-lw1` sorts BELOW `2.8.0` and is excluded from `^2.8.0`,
and `2.8.0+lw1` compares EQUAL to upstream with the build suffix stripped. The
package NAME is the only thing the resolver will not quietly step over, so the
fork is `@lightwebinc/overlay` and keeps the upstream version number to say
plainly which release it tracks.

## Rebuilding

`rebuild.sh` fetches the pinned upstream commit, applies the patch, renames the
package, replaces the monorepo-only `workspace:` dependencies with published
versions (`@bsv/gasp` 1.3.11, `@bsv/sdk` 4.1.2, `@bsv/verifast` 0.3.10), and
builds and packs in a clean Node 24 container. The host pins `@bsv/sdk` to the
same version it builds the fork against.

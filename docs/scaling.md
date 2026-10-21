# Scaling admission

The engine runs on one Node.js thread. This page records where that thread's
time goes, what the host does to use more than one core, and what the next
step would be.

## Where the time goes

Measured with `node --cpu-prof` on a host admitting a steady load of real
signed objects, each a one-input P2PKH transaction with its mined parent in
the BEEF (about 730 bytes, two outputs, one topic), against MySQL on the same
machine and a header source in the bridge's native shape. Shares are of the
engine thread's samples.

| Share | Verifying inline (v0.2.5) | Scripts on two to four workers |
| --- | --- | --- |
| `@bsv/sdk` | 48% (elliptic curve arithmetic for the signature check alone about 40%) | 14% (BEEF parsing, hashing) |
| Database client (knex, mysql2, socket writes, pool) | 17% | 40% |
| Node.js (HTTP, buffers, timers) | 17% | about 20% |
| Garbage collection | 3% | 4% |
| Idle | 5% | 8% |

The engine sends about 14 statements to MySQL for each such object: a
duplicate check, a read of each spent output, and for each admitted output a
transaction of a read, an insert and an upsert of the BEEF, then the
applied-transaction record and the transaction record.

Before this release the engine also asked the header source for the tip once
per admitted topic and for a root once per proven transaction, each an HTTP
round trip on the same thread (one tip and one root request per object
against a bridge). The host now answers a repeated tip for a second and a
valid root for thirty seconds from memory; on the measured load that took
tip requests from one per object to about one per second.

## Worker threads for scripts

The SDK verifies a BEEF through `Transaction.verify`, and has a documented
seam for moving script execution elsewhere: a process-wide script
verification backend (`registerScriptVerificationBackend`). `verify` keeps
everything else on the calling thread (walking the BEEF, checking every merkle
path against the chain tracker, amounts and fees), hands each unmined
transaction's scripts to the backend, and fails the verification if any
verdict is false.

The host registers a backend that sends each transaction (its serialization
and each input's source output) to a pool of worker threads. A worker builds
each input's `Spend` exactly as the SDK's inline path does and runs the SDK's
own interpreter (`Spend.validateJavaScript`), so the verdict is the inline
verdict. The engine is not changed. The difference a submitter can see is the
error text of a refused object: the SDK's backend path says `Script
verification failed for transaction <txid>` where the inline interpreter
throws its own message; both are a 400.

`OVERLAY_VERIFY_WORKERS` sizes the pool (default 2; 0 verifies inline).
Measured on a 72-core machine that was shared with other work throughout
(load average 80 to 150), so the absolute rates are low and noisy and the
ratios are the result:

| Workers | Objects a second | Resident memory |
| --- | --- | --- |
| inline (v0.2.5) | 43 to 53 | 350 MiB |
| 2 | 176 | 500 MiB |
| 4 | 112 to 118 | 700 MiB |
| 8 | 128 | 1,070 MiB |

Two workers keep the engine thread busy: what is left on it per object (BEEF
parsing, the database client, HTTP) costs about what the scripts did, so more
workers wait on it and each one holds its own copy of the SDK (about 80 MiB).
Total CPU per object stays at 15 to 20 ms; it is spread over more cores.

The lab-style check (`node scripts/lab.mjs`) confirms that a refused
signature is still refused with the pool on, and that every script check of
its load went to a worker (`overlay_host_verified_in_workers_total`).

## Verification latency

The target for one SPV verification is under a millisecond. The engine's path
does not meet it yet. The measurement used one transaction shape: a two-input
P2PKH transaction whose mined parent carries a depth-20 merkle path, about
1.3 KB of BEEF, so two signature checks and one path per verification. Each
check was timed on its own, `Transaction.fromBEEF` plus `verify` on one
thread, against go-sdk's `spv.Verify` on the same shape:

| p50 / p99, ms | Ryzen 9 5900XT | Ryzen 5 PRO 4650G | Xeon E5-2699 v3 (2.3 GHz, no turbo) |
| --- | --- | --- | --- |
| `@bsv/sdk` 2.7.1, Node.js 24 | 3.85 / 7.27 | 7.72 / 13.39 | 12.78 / 24.40 |
| go-sdk v1.7.1 | 0.34 / 0.55 | 0.45 / 0.85 | 0.87 / 1.45 |
| One signature check, p50 (`@bsv/sdk` / go-sdk) | 1.44 / 0.14 | 2.94 / 0.19 | 4.47 / 0.34 |

The gap is the signature check. Elliptic curve arithmetic in JavaScript costs
about ten times the Go implementation's, and that matches the profile above,
where it took about 40% of the engine thread. Worker threads spread that cost
over more cores, but they do not shorten any one verification.

## The next step

With scripts moved, the engine thread is bounded by the database client and
BEEF parsing. Three directions: the first two raise objects a second, the
third shortens each verification.

1. **Fewer statements per object.** `KnexStorage.insertOutput` opens a
   transaction per output to read before it inserts and then upserts the
   transaction's BEEF once per output; the duplicate check and the
   applied-transaction record are separate round trips. A storage that
   batched an object's writes into one transaction would take most of the
   40% that the client now costs. It is a change to the engine package (a new
   patch in `vendor/overlay-fork/`), and it must keep every row byte for
   byte what the engine writes today, so it needs its own differential test
   against the current storage.
2. **More than one engine process behind one listener.** Admission state that
   matters is in MySQL: a duplicate check, a spent output and a stored proof
   are rows, and `ls_anytx` reads rows. What is per process is the lookup
   services modules keep in memory. So:
   - topics no module mounts (the parity topics) can be spread over several
     engine processes by txid, which keeps every submission of one
     transaction in one process;
   - each module's topics must stay in one process, the one holding its
     lookup services, and its lookups and routes go there;
   - a submission naming topics in two processes is split, each process
     verifying it again (or the front verifies once and the processes trust
     it, which changes the mode the engine hands topic managers, so not
     without each module's review);
   - the reorg watch runs once and its events are forwarded.

   This multiplies the engine thread by the number of processes for the
   parity topics, and does nothing for a module's topic. It is a larger
   change than this release takes on, and is recorded here with the numbers
   it would be judged against.
3. **Native signature checks.** The script verification backend seam can
   take a backend that checks signatures natively (a libsecp256k1 binding,
   or a verifier process built on go-sdk) instead of in JavaScript. Taking
   only the signature cost out of the numbers above leaves 1.2 to 4.5 ms of
   parsing, hashing and interpreter work, so native signatures alone miss
   the target; the whole verification in go-sdk meets it (0.34 to 0.87 ms).
   Either way the verdict must stay the SDK's own, so it needs a
   differential test against the inline interpreter over valid and refused
   objects, the same check the worker pool passed.

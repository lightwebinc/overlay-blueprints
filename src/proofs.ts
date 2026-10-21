import { Transaction, type ChainTracker, type MerklePath } from '@bsv/sdk'
import type { Engine } from '@lightwebinc/overlay'

/**
 * What happened to a proof that arrived with a duplicate submission.
 *
 * - `upgraded`: the host held the transaction unproven and now holds it proven.
 * - `replaced`: the host held it with a path that no longer verifies against
 *   its own headers (the block left the best chain), and now holds the
 *   submitted path, which does.
 * - `already`: the host already held it with a path that still verifies;
 *   nothing was written.
 * - `no-proof`: the submission carried no merkle path; nothing to do.
 * - `unverified`: the path did not verify against this host's own headers, or
 *   this host has no headers to check against. Refused, never ingested.
 * - `unknown`: this host does not hold the transaction at all.
 * - `error`: something failed that should not have; logged by the caller.
 */
export const ProofResults = ['upgraded', 'replaced', 'already', 'no-proof', 'unverified', 'unknown', 'error'] as const
export type ProofResult = (typeof ProofResults)[number]

type ProofEngine = Pick<Engine, 'handleNewMerkleProof' | 'chainTracker' | 'storage'>

/**
 * Ingest the proof a duplicate submission carries.
 *
 * A publisher that does not wait for mining submits a transaction unproven,
 * and hosts admit it that way: its ancestry verifies, which is all an unmined
 * transaction can show. When it mines, the publisher submits the same
 * transaction again with its merkle path. Those are different bytes, so the
 * plane delivers them to every host like any other object, but the engine
 * sees a txid it already holds and treats the submission as a duplicate,
 * dropping the proof with it. Every host would then go on serving the
 * unproven copy.
 *
 * This is the missing step, and it is safe to take from anyone: the path is
 * verified against this host's OWN chain tracker before anything is written,
 * so a path that does not name a real block is refused, and one that does is
 * true regardless of who sent it. The worst a hostile sender achieves is one
 * verification. Each host upgrades independently, from headers it received
 * itself; nothing asks the publisher or another host.
 *
 * The same holds for a transaction the host already holds proven. When the
 * block its stored path names leaves the best chain and the transaction is
 * mined again elsewhere, the stored path stops verifying, and a submission
 * carrying the new one replaces it: the new path is checked against this
 * host's headers first, and the stored one is checked again and found not to
 * verify, so a valid stored proof is never displaced by another sender.
 *
 * `fresh`, when given, is the tracker the stored path is checked against: one
 * that answers from the header source rather than a cache.
 *
 * Only the submission's subject is upgraded. A publisher that also needs an
 * ancestor proven submits that ancestor as its own object, which keeps the
 * work per submission bounded by one transaction rather than by a BEEF's
 * depth.
 */
export async function ingestProof(engine: ProofEngine, beef: number[], fresh?: ChainTracker): Promise<ProofResult> {
  let tx: Transaction
  try {
    tx = parseSubject(beef)
  } catch {
    // The engine parsed these bytes a moment ago, so this is unexpected.
    return 'error'
  }
  const path = tx.merklePath
  if (path === undefined) return 'no-proof'
  const txid = tx.id('hex')

  // A host with no headers cannot tell a real block from an invented one.
  const tracker = engine.chainTracker
  if (tracker === 'scripts only') return 'unverified'
  try {
    if (!(await path.verify(txid, tracker))) return 'unverified'
  } catch {
    return 'unverified'
  }

  let outputs
  try {
    outputs = await engine.storage.findOutputsForTransaction(txid, true)
  } catch {
    return 'error'
  }
  if (outputs === undefined || outputs.length === 0) return 'unknown'
  // Rewriting storage with a proof it already has would turn every ordinary
  // re-send into a write, so the stored copy is read first.
  const stored = outputs.map((o) => (o.beef === undefined ? undefined : storedPath(o.beef, txid)))
  let result: ProofResult = 'upgraded'
  if (stored.every((s) => s !== undefined)) {
    // Every output's transaction is one stored row, so one path is enough.
    const held = stored[0] as MerklePath
    if (held.blockHeight === path.blockHeight && held.computeRoot(txid) === path.computeRoot(txid)) return 'already'
    // A different block. Keep the stored path while it still verifies: a
    // transaction is in one block of the best chain, and the stored one was
    // checked when it was written.
    // Asked afresh: a cached answer for the stored block would say it is
    // still in the chain for as long as the cache holds it.
    try {
      if (await held.verify(txid, fresh ?? tracker)) return 'already'
    } catch {
      // A header source that cannot answer cannot show the stored path is
      // stale, so nothing is replaced on its say.
      return 'error'
    }
    result = 'replaced'
  }

  try {
    await engine.handleNewMerkleProof(txid, path, path.blockHeight)
  } catch {
    return 'error'
  }
  return result
}

/** The transaction a submission is about: an atomic BEEF's subject, else the BEEF's last transaction. */
function parseSubject(beef: number[]): Transaction {
  try {
    return Transaction.fromAtomicBEEF(beef)
  } catch {
    return Transaction.fromBEEF(beef)
  }
}

/** The merkle path a stored BEEF carries for txid, if any. */
function storedPath(beef: number[], txid: string): MerklePath | undefined {
  try {
    return Transaction.fromBEEF(beef, txid).merklePath
  } catch {
    return undefined
  }
}

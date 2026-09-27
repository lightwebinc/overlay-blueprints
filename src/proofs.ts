import { Transaction } from '@bsv/sdk'
import type { Engine } from '@lightwebinc/overlay'

/**
 * What happened to a proof that arrived with a duplicate submission.
 *
 * - `upgraded`: the host held the transaction unproven and now holds it proven.
 * - `already`: the host already held it proven; nothing was written.
 * - `no-proof`: the submission carried no merkle path; nothing to do.
 * - `unverified`: the path did not verify against this host's own headers, or
 *   this host has no headers to check against. Refused, never ingested.
 * - `unknown`: this host does not hold the transaction at all.
 * - `error`: something failed that should not have; logged by the caller.
 */
export const ProofResults = ['upgraded', 'already', 'no-proof', 'unverified', 'unknown', 'error'] as const
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
 * Only the submission's subject is upgraded. A publisher that also needs an
 * ancestor proven submits that ancestor as its own object, which keeps the
 * work per submission bounded by one transaction rather than by a BEEF's
 * depth.
 */
export async function ingestProof(engine: ProofEngine, beef: number[]): Promise<ProofResult> {
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
  if (outputs.every((o) => o.beef !== undefined && isProven(o.beef, txid))) return 'already'

  try {
    await engine.handleNewMerkleProof(txid, path, path.blockHeight)
  } catch {
    return 'error'
  }
  return 'upgraded'
}

/** The transaction a submission is about: an atomic BEEF's subject, else the BEEF's last transaction. */
function parseSubject(beef: number[]): Transaction {
  try {
    return Transaction.fromAtomicBEEF(beef)
  } catch {
    return Transaction.fromBEEF(beef)
  }
}

/** Whether a stored BEEF already carries a merkle path for txid. */
function isProven(beef: number[], txid: string): boolean {
  try {
    const tx = Transaction.fromBEEF(beef, txid)
    return tx.merklePath !== undefined
  } catch {
    return false
  }
}

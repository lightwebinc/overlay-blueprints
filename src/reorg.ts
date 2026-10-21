import type { Knex } from 'knex'
import type { ChainTracker } from '@bsv/sdk'

/**
 * Noticing that a block this host holds proofs in has left the best chain.
 *
 * The engine records, for every admitted transaction it holds proven, the
 * height and merkle root its path names (`applied_transactions`). The watch
 * asks the header source, afresh, whether each distinct (height, root) of
 * the last `depth` blocks is still the best chain's. One that is not names a
 * disconnected block: every transaction proven in it is demoted to unproven
 * in the engine's own records (`demoteAppliedTransactionToUnproven`, the
 * engine's reorg step), and the modules are told which blocks and which
 * transactions. A transaction demoted this way is mined again elsewhere in
 * the ordinary case; its new path arrives as a resubmission and replaces the
 * stale one (see proofs.ts).
 *
 * The engine's own sweep (`revalidateRecentAnchors`) is keyed by block hash,
 * which it records only when a header resolver is configured for BASM
 * anchors; this host configures none, so the sweep would find nothing to
 * check. The watch is keyed by root, which is always recorded.
 *
 * What it does not see: a block deeper than `depth` at the time it left, and
 * a block that held none of this host's proven transactions (which changes
 * nothing this host answers).
 */

/** A block that left the best chain, named by the height and root its proofs carry. */
export interface DisconnectedBlock {
  readonly height: number
  readonly merkleRoot: string
}

/** What a module is told when blocks it may hold proofs in left the best chain. */
export interface ReorgEvent {
  /** The tip the source answered when the change was seen. */
  readonly tip: number
  readonly disconnected: readonly DisconnectedBlock[]
  /** Every admission demoted to unproven, by topic. */
  readonly demoted: ReadonlyArray<{ txid: string; topic: string; height: number }>
}

export interface ReorgStorage {
  demoteAppliedTransactionToUnproven?: (txid: string, topic: string) => Promise<void>
}

/** The engine's record of proven admissions, as the watch reads it. */
export interface ProofIndex {
  /** Distinct (height, root) of proven admissions on these topics in [from, to]. */
  roots: (topics: readonly string[], from: number, to: number) => Promise<DisconnectedBlock[]>
  /** Proven admissions on these topics in the block with this height and root. */
  provenIn: (topics: readonly string[], block: DisconnectedBlock) => Promise<Array<{ txid: string; topic: string }>>
}

/** ProofIndex over the engine's `applied_transactions` table. */
export class KnexProofIndex implements ProofIndex {
  constructor(private readonly db: Knex) {}

  async roots(topics: readonly string[], from: number, to: number): Promise<DisconnectedBlock[]> {
    // Per topic, so each query is a range on the engine's (topic, blockHeight)
    // index.
    const pairs = new Map<string, DisconnectedBlock>()
    for (const topic of topics) {
      const rows = (await this.db('applied_transactions')
        .where({ topic, proven: true })
        .whereBetween('blockHeight', [from, to])
        .whereNotNull('merkleRoot')
        .distinct('blockHeight', 'merkleRoot')) as Array<{ blockHeight: number; merkleRoot: string }>
      for (const r of rows) {
        pairs.set(`${r.blockHeight}:${r.merkleRoot}`, { height: Number(r.blockHeight), merkleRoot: r.merkleRoot })
      }
    }
    return [...pairs.values()]
  }

  async provenIn(topics: readonly string[], b: DisconnectedBlock): Promise<Array<{ txid: string; topic: string }>> {
    return (await this.db('applied_transactions')
      .whereIn('topic', [...topics])
      .where({ proven: true, blockHeight: b.height, merkleRoot: b.merkleRoot })
      .select('txid', 'topic')) as Array<{ txid: string; topic: string }>
  }
}

export interface WatchDeps {
  readonly proofs: ProofIndex
  readonly storage: ReorgStorage
  /** A tracker that asks the source every time. */
  readonly fresh: ChainTracker
  readonly topics: readonly string[]
  /** Blocks below the tip that are checked; 0 turns the watch off. */
  readonly depth: number
  readonly onReorg: (e: ReorgEvent) => Promise<void> | void
  readonly log: (msg: string, extra?: Record<string, unknown>) => void
}

/**
 * One pass. Returns the event it raised, or undefined when nothing left the
 * chain or the source could not say.
 */
export async function checkReorg(d: WatchDeps): Promise<ReorgEvent | undefined> {
  if (d.depth <= 0 || d.topics.length === 0) return undefined
  if (typeof d.storage.demoteAppliedTransactionToUnproven !== 'function') return undefined
  let tip: number
  try {
    tip = await d.fresh.currentHeight()
  } catch {
    return undefined
  }
  const from = Math.max(0, tip - d.depth + 1)
  const pairs = await d.proofs.roots(d.topics, from, tip)
  const disconnected: DisconnectedBlock[] = []
  for (const p of pairs) {
    // A source that is behind (just restarted, still catching up) does not
    // know a height above its own tip, and must not read as a reorg; nor
    // does a source that errors.
    if (p.height > tip) continue
    let ok: boolean
    try {
      ok = await d.fresh.isValidRootForHeight(p.merkleRoot, p.height)
    } catch {
      return undefined
    }
    if (!ok) disconnected.push(p)
  }
  if (disconnected.length === 0) return undefined

  const demoted: Array<{ txid: string; topic: string; height: number }> = []
  for (const b of disconnected) {
    const rows = await d.proofs.provenIn(d.topics, b)
    for (const r of rows) {
      await d.storage.demoteAppliedTransactionToUnproven(r.txid, r.topic)
      demoted.push({ txid: r.txid, topic: r.topic, height: b.height })
    }
  }
  const e: ReorgEvent = { tip, disconnected, demoted }
  d.log('blocks left the best chain', {
    tip,
    blocks: disconnected.map((b) => b.height).join(','),
    demoted: demoted.length,
  })
  try {
    await d.onReorg(e)
  } catch (err) {
    d.log('reorg listener failed', { err: String(err) })
  }
  return e
}

/** Runs `checkReorg` every `everyMs`, one pass at a time. Returns a stop function. */
export function watchReorgs(d: WatchDeps, everyMs: number): () => void {
  if (d.depth <= 0) return () => {}
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    checkReorg(d)
      .catch((err: unknown) => d.log('reorg check failed', { err: String(err) }))
      .finally(() => {
        running = false
      })
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

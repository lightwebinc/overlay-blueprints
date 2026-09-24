import type {
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  LookupServiceMetaData,
} from '@lightwebinc/overlay'
import type { LookupFormula } from '@lightwebinc/overlay'
import type { LookupQuestion } from '@bsv/sdk'

/**
 * `ls_anytx` indexes what `tm_anytx` admitted and answers by outpoint.
 *
 * The index is the parity oracle's read side: two hosts fed the same objects
 * must answer the same set. It is held in memory on purpose, because it is
 * derived state that the engine's own storage already holds durably, and a
 * second durable store would be a second thing for two hosts to disagree
 * about.
 *
 * That choice has a consequence that has to be paid for rather than assumed
 * away, and it was found by restarting a host that had admitted five objects:
 * the engine does NOT replay past admissions into a lookup service on start,
 * so the index came back empty while the engine still held every output. The
 * host answered an authoritative empty set, and a parity oracle comparing it
 * with its unrestarted sibling would have read an ordinary restart as the two
 * hosts disagreeing. `restore` is the answer: the host rebuilds the index from
 * the engine's own storage before it reports itself ready.
 *
 * A lookup service answers with a FORMULA, a list of outpoints the engine then
 * hydrates from its own storage, not with documents of its own. So this
 * service never holds object bytes, and two hosts comparing answers are
 * comparing exactly the outpoints each admitted.
 */
/**
 * Index of the first key strictly greater than `after`.
 *
 * Binary search rather than a filter: the walk is O(pages x log n) instead of
 * O(pages x n), which matters because the oracle calls this once per page over
 * an index that is tens of thousands of rows and growing.
 */
function upperBound(keys: readonly string[], after: string): number {
  let lo = 0
  let hi = keys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // noUncheckedIndexedAccess is on: mid is always in range here, but the
    // compiler cannot know that, and a non-null assertion would be the wrong
    // habit to establish in an index walk.
    const k = keys[mid] ?? ''
    if (k <= after) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class AnyTxLookupService implements LookupService {
  /**
   * `locking-script` rather than `whole-tx`: the admission callback then
   * carries the txid and the output's script, and this service needs the
   * outpoint only. Asking for `whole-tx` would hand it an atomic BEEF per
   * admission to parse and throw away.
   */
  readonly admissionMode = 'locking-script' as const
  readonly spendNotificationMode = 'txid' as const

  /** outpoint ("txid.index") -> the topic it was admitted into. */
  private readonly admitted = new Map<string, string>()

  /** Number of outpoints indexed, for the host's own metrics. */
  get size(): number {
    return this.admitted.size
  }

  private static key(txid: string, outputIndex: number): string {
    return `${txid}.${outputIndex}`
  }

  private static split(outpoint: string): { txid: string; outputIndex: number } | undefined {
    const at = outpoint.lastIndexOf('.')
    if (at <= 0) return undefined
    const txid = outpoint.slice(0, at)
    const outputIndex = Number(outpoint.slice(at + 1))
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return undefined
    return { txid, outputIndex }
  }

  /**
   * Rebuild the index from outputs the engine's storage already holds.
   *
   * Called once per topic at startup, before the port opens. Unspent outputs
   * only: a spent one was removed from the index when it was spent, and
   * putting it back would make a restarted host answer with more than its
   * sibling rather than less.
   */
  restore(outputs: Array<{ txid: string; outputIndex: number; topic: string; spent: boolean }>): number {
    let restored = 0
    for (const o of outputs) {
      if (o.spent) continue
      this.admitted.set(AnyTxLookupService.key(o.txid, o.outputIndex), o.topic)
      restored++
    }
    return restored
  }

  outputAdmittedByTopic(payload: OutputAdmittedByTopic): void {
    if (payload.mode !== 'locking-script') return // cannot happen: admissionMode is fixed above
    this.admitted.set(AnyTxLookupService.key(payload.txid, payload.outputIndex), payload.topic)
  }

  outputSpent(payload: OutputSpent): void {
    this.admitted.delete(AnyTxLookupService.key(payload.txid, payload.outputIndex))
  }

  outputEvicted(txid: string, outputIndex: number): void {
    this.admitted.delete(AnyTxLookupService.key(txid, outputIndex))
  }

  /** Outpoints per page when `{ all: true }` does not ask for fewer. */
  static readonly PAGE = 1000

  /**
   * Three questions:
   *
   *   { outpoint: "<txid>.<index>" }        one outpoint, present or not
   *   { all: true }                         one PAGE of outpoints, sorted
   *   { all: true, after: "<outpoint>",
   *     limit?: number }                    the next page after that outpoint
   *
   * `{ all: true }` is what the parity oracle walks, and it is sorted so two
   * hosts produce byte-comparable answers rather than answers that agree as
   * sets and differ as lists.
   *
   * IT IS PAGED, and that is a correction rather than a feature. This used to
   * return the whole index, on the assumption written here that "the index is
   * the fixed phase-0 object set". That assumption expired: a host running for
   * an afternoon holds tens of thousands of outputs, and the unpaged answer
   * failed twice over - first against the engine's own 1000-result hydration
   * cap, and then, with that cap lifted, against a 64 MiB response bound at
   * 33,093 outputs. The acceptance gate that compares two hosts was therefore
   * unevaluable on exactly the hosts it exists to compare.
   *
   * Pagination is KEYSET, not offset. An offset walk over an index that is
   * still admitting silently skips and repeats rows, which in a parity oracle
   * is indistinguishable from the divergence it is looking for. `after` is an
   * outpoint and the walk is strictly greater than it, so a row admitted
   * mid-walk either lands ahead of the cursor and is seen, or behind it and is
   * not - never both, never neither.
   */
  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const q = question.query as {
      outpoint?: unknown
      all?: unknown
      after?: unknown
      limit?: unknown
    } | undefined
    if (q?.all === true) {
      const limit =
        typeof q.limit === 'number' && Number.isInteger(q.limit) && q.limit > 0
          ? Math.min(q.limit, AnyTxLookupService.PAGE)
          : AnyTxLookupService.PAGE
      const after = typeof q.after === 'string' ? q.after : undefined
      const keys = [...this.admitted.keys()].sort()
      const start = after === undefined ? 0 : upperBound(keys, after)
      return keys
        .slice(start, start + limit)
        .map((o) => AnyTxLookupService.split(o))
        .filter((o): o is { txid: string; outputIndex: number } => o !== undefined)
    }
    if (typeof q?.outpoint === 'string') {
      if (!this.admitted.has(q.outpoint)) return []
      const o = AnyTxLookupService.split(q.outpoint)
      return o === undefined ? [] : [o]
    }
    throw new Error('ls_anytx: ask { outpoint: "<txid>.<index>" } or { all: true }')
  }

  async getDocumentation(): Promise<string> {
    return [
      '# ls_anytx',
      '',
      'Answers `{ outpoint }` for one outpoint and `{ all: true }` for every',
      'outpoint this host has admitted, sorted. The second is what the parity',
      'oracle compares between two hosts.',
    ].join('\n')
  }

  async getMetaData(): Promise<LookupServiceMetaData> {
    return { name: 'ls_anytx', shortDescription: 'Indexes tm_anytx admissions; answers by outpoint.' }
  }
}

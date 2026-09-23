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

  /**
   * Two questions, both deliberately small:
   *
   *   { outpoint: "<txid>.<index>" }  one outpoint, present or not
   *   { all: true }                   every outpoint this host holds, sorted
   *
   * The second is what the parity oracle records, and it is sorted so two
   * hosts produce byte-comparable answers rather than answers that agree as
   * sets and differ as lists. It is a whole-index read, which a real lookup
   * service would bound; here the index is the fixed phase-0 object set and
   * the comparison needs all of it.
   */
  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const q = question.query as { outpoint?: unknown; all?: unknown } | undefined
    if (q?.all === true) {
      return [...this.admitted.keys()]
        .sort()
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

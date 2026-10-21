import type { Knex } from 'knex'
import type {
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  LookupServiceMetaData,
} from '@lightwebinc/overlay'
import type { LookupFormula } from '@lightwebinc/overlay'
import type { LookupQuestion } from '@bsv/sdk'

/**
 * `ls_anytx` answers by outpoint for every unspent output the host holds on
 * the topics it carries.
 *
 * It is the parity oracle's read side: two hosts fed the same objects must
 * answer the same set. Its answers are read from the engine's own storage at
 * the time of the question, not from an index of its own. It used to hold
 * every outpoint in memory and rebuild that set from storage on every start,
 * which made start-up time and heap grow with the topic: a lab host with
 * 1.39 M unspent outputs needed about 115 s and 2.5 GiB to start, and with
 * the default heap it did not start at all. Reading storage instead makes the
 * start constant and the memory a page's worth, and there is no second copy
 * of the set for two hosts to disagree about.
 *
 * The answers are the ones a restarted host gave: an outpoint is present
 * while an unspent row for it exists on any carried topic. (A host that had
 * not restarted used to drop an outpoint admitted on two topics as soon as it
 * was spent on one; a restart brought it back. The two now agree.)
 *
 * A lookup service answers with a FORMULA, a list of outpoints the engine then
 * hydrates from its own storage, not with documents of its own. So this
 * service never holds object bytes, and two hosts comparing answers are
 * comparing exactly the outpoints each admitted.
 */

/** Where the outpoints are read from: the engine's storage, or a table in a test. */
export interface OutpointStore {
  /** Whether an unspent row for this outpoint exists on a carried topic. */
  has: (txid: string, outputIndex: number) => Promise<boolean>
  /**
   * Up to `limit` distinct txids with an unspent row on a carried topic, each
   * at or above `bound`, ascending. `bound` is always 64 lower-case hex
   * characters, so byte order and the column's collation agree on it.
   */
  txidsFrom: (bound: string, limit: number) => Promise<string[]>
  /** The unspent outpoints of these txids on carried topics, in any order. */
  outputsOf: (txids: readonly string[]) => Promise<Array<{ txid: string; outputIndex: number }>>
  /** Unspent rows on carried topics (an outpoint on two topics is two). */
  count: () => Promise<number>
}

const HEX = '0123456789abcdef'
const TXID = /^[0-9a-f]{64}$/
const INDEX = /^(0|[1-9][0-9]*)$/

/**
 * The least 64-character lower-case hex string that is not below `s` in byte
 * order, or undefined when none is. Every stored txid has that shape, so a
 * txid is at or above `s` exactly when it is at or above this bound, and the
 * bound can be handed to the database whatever the cursor held.
 */
export function hexLowerBound(s: string): string | undefined {
  const p = s.slice(0, 64)
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i)
    if (HEX.includes(c)) continue
    if (c < '0') return p.slice(0, i) + '0'.repeat(64 - i)
    if (c < 'a') return p.slice(0, i) + 'a' + '0'.repeat(63 - i)
    // Above 'f': no hex string with this prefix is high enough, so carry.
    for (let j = i - 1; j >= 0; j--) {
      const k = HEX.indexOf(p.charAt(j))
      if (k < 15) return p.slice(0, j) + HEX.charAt(k + 1) + '0'.repeat(63 - j)
    }
    return undefined
  }
  return p + '0'.repeat(64 - p.length)
}

/** The outpoints of the engine's `outputs` table, as KnexStorage writes them. */
export class KnexOutpointStore implements OutpointStore {
  constructor(
    private readonly db: Knex,
    private readonly topics: readonly string[],
  ) {}

  private unspent(): Knex.QueryBuilder {
    return this.db('outputs').where('spent', false).whereIn('topic', [...this.topics])
  }

  async has(txid: string, outputIndex: number): Promise<boolean> {
    const row = await this.unspent().andWhere({ txid, outputIndex }).first(this.db.raw('1 as one'))
    return row !== undefined
  }

  async txidsFrom(bound: string, limit: number): Promise<string[]> {
    const rows = (await this.unspent()
      .andWhere('txid', '>=', bound)
      .distinct('txid')
      .orderBy('txid', 'asc')
      .limit(limit)) as Array<{ txid: string }>
    return rows.map((r) => r.txid)
  }

  async outputsOf(txids: readonly string[]): Promise<Array<{ txid: string; outputIndex: number }>> {
    if (txids.length === 0) return []
    const rows = (await this.unspent()
      .whereIn('txid', [...txids])
      .select('txid', 'outputIndex')) as Array<{ txid: string; outputIndex: number }>
    return rows.map((r) => ({ txid: r.txid, outputIndex: Number(r.outputIndex) }))
  }

  async count(): Promise<number> {
    // A range on the engine's (topic, spent, score) index per topic. An
    // outpoint held on two topics counts twice; counting distinct outpoints
    // reads every row, which on a lab host's 1.4 M took nine seconds.
    let n = 0
    for (const topic of this.topics) {
      const row = (await this.db('outputs').where({ topic, spent: false }).count('* as n').first()) as
        | { n: number | string }
        | undefined
      n += Number(row?.n ?? 0)
    }
    return n
  }
}

export class AnyTxLookupService implements LookupService {
  /**
   * `locking-script` rather than `whole-tx`: the cheapest notification the
   * engine sends, and this service reads nothing from it.
   */
  readonly admissionMode = 'locking-script' as const
  readonly spendNotificationMode = 'none' as const

  private counted = 0

  constructor(private readonly store: OutpointStore) {}

  /**
   * Unspent rows held, as last counted (see refreshSize). A gauge is read
   * synchronously at scrape time, and counting is a query.
   */
  get size(): number {
    return this.counted
  }

  /** Counts the outpoints again, for the gauge. */
  async refreshSize(): Promise<number> {
    this.counted = await this.store.count()
    return this.counted
  }

  /** Storage is the index: the engine wrote the row before it told us. */
  outputAdmittedByTopic(_payload: OutputAdmittedByTopic): void {}

  outputSpent(_payload: OutputSpent): void {}

  outputEvicted(_txid: string, _outputIndex: number): void {}

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
   * `{ all: true }` is what the parity oracle walks. It is sorted by the
   * outpoint STRING ("<txid>.<index>", so "….10" comes before "….2"), which
   * keeps two hosts' answers byte-comparable as lists and not only as sets.
   *
   * IT IS PAGED, and the pagination is KEYSET, not offset. An offset walk
   * over a set that is still admitting silently skips and repeats rows,
   * which in a parity oracle is indistinguishable from the divergence it is
   * looking for. `after` is an outpoint and the walk is strictly greater
   * than it, so a row admitted mid-walk either lands ahead of the cursor and
   * is seen, or behind it and is not, never both and never neither.
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
      return await this.page(after, limit)
    }
    if (typeof q?.outpoint === 'string') {
      const o = parseOutpoint(q.outpoint)
      if (o === undefined) return []
      return (await this.store.has(o.txid, o.outputIndex)) ? [o] : []
    }
    throw new Error('ls_anytx: ask { outpoint: "<txid>.<index>" } or { all: true }')
  }

  /**
   * One page strictly after `after`. Every key of a txid sorts before every
   * key of a greater txid, because a txid is 64 characters, so a page is the
   * keys of the first txids at or above the cursor's own. Only the cursor's
   * txid can hold keys at or below the cursor, so `limit + 1` txids always
   * hold `limit` keys past it when that many exist.
   */
  private async page(after: string | undefined, limit: number): Promise<LookupFormula> {
    const bound = hexLowerBound(after ?? '')
    if (bound === undefined) return []
    const txids = await this.store.txidsFrom(bound, limit + 1)
    const keys = new Set<string>()
    for (const o of await this.store.outputsOf(txids)) keys.add(`${o.txid}.${o.outputIndex}`)
    const sorted = [...keys].sort()
    const out: Array<{ txid: string; outputIndex: number }> = []
    for (const k of sorted) {
      if (after !== undefined && k <= after) continue
      const o = parseOutpoint(k)
      if (o !== undefined) out.push(o)
      if (out.length === limit) break
    }
    return out
  }

  async getDocumentation(): Promise<string> {
    return [
      '# ls_anytx',
      '',
      'Answers `{ outpoint }` for one outpoint and `{ all: true }` for every',
      'unspent outpoint this host holds, sorted and paged. The second is what',
      'the parity oracle compares between two hosts.',
    ].join('\n')
  }

  async getMetaData(): Promise<LookupServiceMetaData> {
    return { name: 'ls_anytx', shortDescription: 'Answers by outpoint for every unspent output the host holds.' }
  }
}

/**
 * "<txid>.<index>" exactly as the engine writes it: a lower-case 64-hex txid
 * and an index with no sign, no leading zero and no exponent. Anything else
 * names no stored outpoint.
 */
function parseOutpoint(s: string): { txid: string; outputIndex: number } | undefined {
  const at = s.lastIndexOf('.')
  if (at <= 0) return undefined
  const txid = s.slice(0, at)
  const idx = s.slice(at + 1)
  if (!TXID.test(txid) || !INDEX.test(idx)) return undefined
  const outputIndex = Number(idx)
  if (!Number.isSafeInteger(outputIndex)) return undefined
  return { txid, outputIndex }
}

import type { Knex } from 'knex'
import type { Output } from '@lightwebinc/overlay'

/**
 * Reading a topic's unspent outputs back out of the engine's storage, a page
 * at a time.
 *
 * The engine's own `findUTXOsForTopic` returns a whole topic in one array,
 * with every BEEF copied into a JavaScript number array (eight bytes a byte
 * on the heap). A module restore that asked for a large topic that way held
 * all of it at once. These read the same rows, in the same order (by score,
 * the admission time, with the row id breaking ties so a page boundary never
 * skips or repeats a row), into the same Output shape.
 */

const FIELDS = [
  'outputs.id',
  'outputs.txid',
  'outputs.outputIndex',
  'outputs.outputScript',
  'outputs.topic',
  'outputs.satoshis',
  'outputs.outputsConsumed',
  'outputs.spent',
  'outputs.consumedBy',
  'outputs.blockHeight',
  'outputs.score',
] as const

interface Row {
  id: number
  txid: string
  outputIndex: number
  outputScript: Buffer
  topic: string
  satoshis: number
  outputsConsumed: string
  spent: number | boolean
  consumedBy: string
  blockHeight: number | null
  score: number
}

/**
 * A Buffer's bytes as a number array. `Array.from` on a Buffer walks the
 * iterator and costs about 70 us for 1.5 KB; this costs about 20 and builds
 * the same packed array.
 */
function bytes(b: Buffer): number[] {
  const a: number[] = []
  for (let i = 0; i < b.length; i++) a.push(b[i] as number)
  return a
}

function relations(v: unknown): Array<{ txid: string; outputIndex: number }> {
  return Array.isArray(v) ? v : (JSON.parse(String(v)) as Array<{ txid: string; outputIndex: number }>)
}

/**
 * The Output KnexStorage builds from a row, field for field and in the same
 * key order. With `lazy`, the BEEF is kept as the database's bytes and turned
 * into a number array each time it is read, so a held Output costs its bytes
 * rather than eight times them; assigning to it replaces it as on a plain
 * object.
 */
function toOutput(row: Row, includeBEEF: boolean, beef: Buffer | undefined, lazy: boolean): Output {
  const o: Record<string, unknown> = {
    txid: row.txid,
    outputIndex: row.outputIndex,
    outputScript: bytes(row.outputScript),
    topic: row.topic,
    satoshis: row.satoshis,
    outputsConsumed: relations(row.outputsConsumed),
    spent: Boolean(row.spent),
    consumedBy: relations(row.consumedBy),
    blockHeight: row.blockHeight,
    score: row.score,
  }
  if (!includeBEEF || beef === undefined) {
    o['beef'] = undefined
  } else if (!lazy) {
    o['beef'] = bytes(beef)
  } else {
    let held: Buffer | number[] = beef
    Object.defineProperty(o, 'beef', {
      enumerable: true,
      configurable: true,
      get: () => (Array.isArray(held) ? held : bytes(held)),
      set: (v: number[]) => {
        held = v
      },
    })
  }
  return o as unknown as Output
}

export interface PageOptions {
  /** Rows a page holds. */
  readonly pageSize?: number
  /** Read each row's BEEF too. */
  readonly includeBEEF?: boolean
  /** Keep the BEEF as bytes until it is read (see toOutput). */
  readonly lazyBEEF?: boolean
}

/** The unspent outputs of one topic, a page at a time, in score order. */
export async function* unspentPages(db: Knex, topic: string, opts: PageOptions = {}): AsyncGenerator<Output[]> {
  const size = opts.pageSize ?? 1000
  const includeBEEF = opts.includeBEEF ?? false
  let cursor: { score: number; id: number } | undefined
  for (;;) {
    const q = db('outputs').where({ 'outputs.topic': topic, 'outputs.spent': false })
    if (cursor !== undefined) {
      const c = cursor
      // `score >= c` first, so the database starts the page on the
      // (topic, spent, score) index at the cursor instead of walking every
      // earlier row; the OR then drops the ties already read.
      void q.andWhere('outputs.score', '>=', c.score).andWhere((b) => {
        void b.where('outputs.score', '>', c.score).orWhere('outputs.id', '>', c.id)
      })
    }
    const rows = (await q.orderBy([
      { column: 'outputs.score', order: 'asc' },
      { column: 'outputs.id', order: 'asc' },
    ]).limit(size).select([...FIELDS])) as Row[]
    if (rows.length === 0) return
    let beefs = new Map<string, Buffer>()
    if (includeBEEF) {
      const txids = [...new Set(rows.map((r) => r.txid))]
      const found = (await db('transactions').whereIn('txid', txids).select('txid', 'beef')) as Array<{
        txid: string
        beef: Buffer | null
      }>
      beefs = new Map(found.filter((r) => r.beef !== null).map((r) => [r.txid, r.beef as Buffer]))
    }
    yield rows.map((r) => toOutput(r, includeBEEF, beefs.get(r.txid), opts.lazyBEEF ?? false))
    const last = rows[rows.length - 1] as Row
    cursor = { score: last.score, id: last.id }
    if (rows.length < size) return
  }
}

/** Every row of every page, one Output at a time. */
export async function* unspentOutputs(db: Knex, topics: readonly string[], opts: PageOptions = {}): AsyncGenerator<Output> {
  for (const t of topics) {
    for await (const page of unspentPages(db, t, opts)) yield* page
  }
}

import type { OutpointStore } from './lookup/anytx.js'

/** One row of the engine's outputs table, as far as ls_anytx reads it. */
export interface Row {
  txid: string
  outputIndex: number
  topic: string
  spent: boolean
}

/**
 * The OutpointStore contract over an array, for tests: the queries
 * KnexOutpointStore sends, answered by the same rules (unspent rows on
 * carried topics, txids compared as bytes).
 */
export class TableOutpointStore implements OutpointStore {
  constructor(
    readonly rows: Row[],
    private readonly topics: readonly string[],
  ) {}

  private live(): Row[] {
    return this.rows.filter((r) => !r.spent && this.topics.includes(r.topic))
  }

  async has(txid: string, outputIndex: number): Promise<boolean> {
    return this.live().some((r) => r.txid === txid && r.outputIndex === outputIndex)
  }

  async txidsFrom(bound: string, limit: number): Promise<string[]> {
    return [...new Set(this.live().map((r) => r.txid))].filter((t) => t >= bound).sort().slice(0, limit)
  }

  async outputsOf(txids: readonly string[]): Promise<Array<{ txid: string; outputIndex: number }>> {
    return this.live()
      .filter((r) => txids.includes(r.txid))
      .map((r) => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }

  async count(): Promise<number> {
    return this.live().length
  }
}

/**
 * Against a real MySQL, when OVERLAY_TEST_KNEX_URL names an empty database:
 * the reads that replaced in-memory state answer what the engine's own
 * storage answers. Skipped otherwise (CI has no database).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { Output } from '@lightwebinc/overlay'
import { openStorage } from './storage.js'
import { AnyTxLookupService, KnexOutpointStore } from './lookup/anytx.js'
import { TableOutpointStore, type Row } from './testutil.js'
import { unspentPages } from './restore.js'
import { KnexProofIndex } from './reorg.js'

const url = process.env['OVERLAY_TEST_KNEX_URL'] ?? ''

test('storage-backed reads agree with the engine storage and with the table model', { skip: url === '' }, async () => {
  const { db, storage } = await openStorage(url)
  try {
    const key = PrivateKey.fromRandom()
    const lock = new P2PKH().lock(key.toAddress())
    const rows: Row[] = []
    const topics = ['tm_a', 'tm_b']
    for (let i = 0; i < 120; i++) {
      const tx = new Transaction()
      tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: i, unlockingScript: lock, sequence: 0xffffffff })
      const outs = 1 + (i % 12)
      for (let o = 0; o < outs; o++) tx.addOutput({ lockingScript: lock, satoshis: 1 + o })
      if (i % 3 === 0) tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), 100 + i)
      const txid = tx.id('hex')
      const beef = tx.toBEEF()
      for (let o = 0; o < outs; o++) {
        const topic = topics[(i + o) % 2] as string
        const spent = (i * 7 + o) % 5 === 0
        // Repeated scores: a page boundary must not skip or repeat a tie.
        const score = 1_000 + Math.floor(i / 4)
        await storage.insertOutput({
          txid, outputIndex: o, outputScript: lock.toBinary(), topic, satoshis: 1 + o, spent,
          beef, consumedBy: [], outputsConsumed: [], score,
        })
        rows.push({ txid, outputIndex: o, topic, spent })
        if (o % 4 === 0) {
          // The same outpoint on the other topic too.
          const other = topics[(i + o + 1) % 2] as string
          await storage.insertOutput({
            txid, outputIndex: o, outputScript: lock.toBinary(), topic: other, satoshis: 1 + o, spent: false,
            beef, consumedBy: [], outputsConsumed: [], score,
          })
          rows.push({ txid, outputIndex: o, topic: other, spent: false })
        }
      }
      await storage.insertAppliedTransaction({ txid, topic: 'tm_a', blockHeight: tx.merklePath === undefined ? undefined : 100 + i, merkleRoot: tx.merklePath?.computeRoot(txid), proven: tx.merklePath !== undefined })
    }
    // Rows of a topic the host no longer carries.
    rows.push({ txid: 'ff'.repeat(32), outputIndex: 0, topic: 'tm_gone', spent: false })
    await storage.insertOutput({ txid: 'ff'.repeat(32), outputIndex: 0, outputScript: [], topic: 'tm_gone', satoshis: 1, spent: false, consumedBy: [], outputsConsumed: [], score: 1 })

    const viaDb = new AnyTxLookupService(new KnexOutpointStore(db, topics))
    const model = new AnyTxLookupService(new TableOutpointStore(rows, topics))
    const ask = async (ls: AnyTxLookupService, query: unknown): Promise<unknown> => await ls.lookup({ service: 'ls_anytx', query } as never)
    const all = (await ask(model, { all: true, limit: 1000 })) as Array<{ txid: string; outputIndex: number }>
    const keys = all.map((o) => `${o.txid}.${o.outputIndex}`)
    assert.ok(keys.length > 200)
    const cursors = [undefined, ...keys.filter((_, i) => i % 9 === 0), ...keys.slice(0, 20).map((k) => k.slice(0, 5)), 'G', 'f'.repeat(70), '']
    for (const after of cursors) {
      for (const limit of [1, 5, 1000]) {
        const q = after === undefined ? { all: true, limit } : { all: true, after, limit }
        assert.deepEqual(await ask(viaDb, q), await ask(model, q), `after ${after} limit ${limit}`)
      }
    }
    for (const k of [...keys.slice(0, 30), `${'ff'.repeat(32)}.0`, `${keys[0]?.toUpperCase()}`]) {
      assert.deepEqual(await ask(viaDb, { outpoint: k }), await ask(model, { outpoint: k }), k)
    }
    assert.equal(await viaDb.refreshSize(), await model.refreshSize())

    for (const topic of topics) {
      const engine = await storage.findUTXOsForTopic(topic, undefined, undefined, true)
      const strip = (o: Output): string => JSON.stringify(o)
      for (const lazyBEEF of [false, true]) {
        const paged: Output[] = []
        for await (const page of unspentPages(db, topic, { pageSize: 7, includeBEEF: true, lazyBEEF })) paged.push(...page)
        assert.equal(paged.length, engine.length)
        assert.deepEqual(paged.map(strip).sort(), engine.map(strip).sort(), 'the same Outputs, field for field')
        for (let i = 1; i < paged.length; i++) assert.ok((paged[i - 1]?.score ?? 0) <= (paged[i]?.score ?? 0), 'in score order')
      }
      const bare: Output[] = []
      for await (const page of unspentPages(db, topic, { pageSize: 50 })) bare.push(...page)
      const noBeef = await storage.findUTXOsForTopic(topic)
      assert.deepEqual(bare.map((o) => JSON.stringify(o)).sort(), noBeef.map((o) => JSON.stringify(o)).sort())
    }

    const roots = await new KnexProofIndex(db).roots(['tm_a'], 100, 160)
    assert.equal(roots.length, 21)
    const inBlock = await new KnexProofIndex(db).provenIn(['tm_a'], roots[0] as never)
    assert.equal(inBlock.length, 1)
  } finally {
    await db.destroy()
  }
})

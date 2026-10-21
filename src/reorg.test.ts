import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChainTracker } from '@bsv/sdk'
import { checkReorg, type DisconnectedBlock, type ProofIndex, type ReorgEvent, type WatchDeps } from './reorg.js'
import { CachedChainTracker } from './chaintracker.js'

interface Admission {
  txid: string
  topic: string
  height: number
  root: string
  proven: boolean
}

function index(rows: Admission[]): ProofIndex {
  return {
    roots: async (topics, from, to) => {
      const m = new Map<string, DisconnectedBlock>()
      for (const r of rows) {
        if (r.proven && topics.includes(r.topic) && r.height >= from && r.height <= to) {
          m.set(`${r.height}:${r.root}`, { height: r.height, merkleRoot: r.root })
        }
      }
      return [...m.values()]
    },
    provenIn: async (topics, b) =>
      rows
        .filter((r) => r.proven && topics.includes(r.topic) && r.height === b.height && r.root === b.merkleRoot)
        .map((r) => ({ txid: r.txid, topic: r.topic })),
  }
}

function deps(rows: Admission[], chain: Map<number, string>, tip: number, over: Partial<WatchDeps> = {}) {
  const events: ReorgEvent[] = []
  const d: WatchDeps = {
    proofs: index(rows),
    storage: {
      demoteAppliedTransactionToUnproven: async (txid, topic) => {
        for (const r of rows) if (r.txid === txid && r.topic === topic) r.proven = false
      },
    },
    fresh: {
      isValidRootForHeight: async (root, h) => chain.get(h) === root,
      currentHeight: async () => tip,
    },
    topics: ['t', 'u'],
    depth: 10,
    onReorg: (e) => {
      events.push(e)
    },
    log: () => {},
    ...over,
  }
  return { d, events }
}

const R = (c: string): string => c.repeat(64)

test('a block that left the chain demotes its admissions and tells the modules once', async () => {
  const rows: Admission[] = [
    { txid: 'a', topic: 't', height: 100, root: R('1'), proven: true },
    { txid: 'b', topic: 'u', height: 100, root: R('1'), proven: true },
    { txid: 'c', topic: 't', height: 101, root: R('2'), proven: true },
    { txid: 'd', topic: 'other', height: 100, root: R('1'), proven: true },
  ]
  // Block 100 was replaced by another; 101 is still there.
  const chain = new Map([[100, R('9')], [101, R('2')]])
  const { d, events } = deps(rows, chain, 105)
  const e = await checkReorg(d)
  assert.deepEqual(e?.disconnected, [{ height: 100, merkleRoot: R('1') }])
  assert.deepEqual(e?.demoted, [
    { txid: 'a', topic: 't', height: 100 },
    { txid: 'b', topic: 'u', height: 100 },
  ])
  assert.equal(rows[3]?.proven, true, 'a topic this host does not carry is not touched')
  assert.equal(rows[2]?.proven, true)
  assert.equal(events.length, 1)
  // Demoted rows are no longer proven, so the next pass finds nothing.
  assert.equal(await checkReorg(d), undefined)
  assert.equal(events.length, 1)
})

test('nothing is demoted when the source is behind, fails, or the block is out of depth', async () => {
  const mk = (): Admission[] => [{ txid: 'a', topic: 't', height: 100, root: R('1'), proven: true }]
  // Behind: the source's tip is below the proof's height.
  let rows = mk()
  assert.equal(await checkReorg(deps(rows, new Map(), 99).d), undefined)
  assert.equal(rows[0]?.proven, true)
  // Fails on a root.
  rows = mk()
  const failing: ChainTracker = { isValidRootForHeight: async () => { throw new Error('down') }, currentHeight: async () => 105 }
  assert.equal(await checkReorg(deps(rows, new Map(), 105, { fresh: failing }).d), undefined)
  assert.equal(rows[0]?.proven, true)
  // Fails on the tip.
  const noTip: ChainTracker = { isValidRootForHeight: async () => false, currentHeight: async () => { throw new Error('down') } }
  assert.equal(await checkReorg(deps(rows, new Map(), 105, { fresh: noTip }).d), undefined)
  assert.equal(rows[0]?.proven, true)
  // Deeper than the watch looks.
  assert.equal(await checkReorg(deps(rows, new Map(), 200).d), undefined)
  assert.equal(rows[0]?.proven, true)
  // Off.
  assert.equal(await checkReorg(deps(rows, new Map(), 105, { depth: 0 }).d), undefined)
  assert.equal(rows[0]?.proven, true)
})

test('a listener that throws does not stop the demotion', async () => {
  const rows: Admission[] = [{ txid: 'a', topic: 't', height: 100, root: R('1'), proven: true }]
  const { d } = deps(rows, new Map(), 105, { onReorg: () => { throw new Error('module bug') } })
  const e = await checkReorg(d)
  assert.equal(e?.demoted.length, 1)
  assert.equal(rows[0]?.proven, false)
})

test('the cached tracker reuses a tip and a valid root, and fresh asks again', async () => {
  let tips = 0
  let asks = 0
  let valid = true
  const inner: ChainTracker & { forget: (h: number) => void; forgot: number[] } = {
    forgot: [],
    forget(h: number) { this.forgot.push(h) },
    isValidRootForHeight: async () => { asks++; return valid },
    currentHeight: async () => { tips++; return 7 },
  }
  const c = new CachedChainTracker(inner, { tipMs: 60_000, rootMs: 60_000 })
  assert.deepEqual(await Promise.all([c.currentHeight(), c.currentHeight(), c.currentHeight()]), [7, 7, 7])
  assert.equal(tips, 1, 'callers in flight share one request, and the answer is reused')
  assert.equal(await c.isValidRootForHeight(R('a'), 5), true)
  assert.equal(await c.isValidRootForHeight(R('a').toUpperCase(), 5), true)
  assert.equal(asks, 1, 'a valid root is reused')
  assert.equal(await c.isValidRootForHeight(R('b'), 5), true)
  assert.equal(asks, 2, 'another root at the same height is asked')
  valid = false
  assert.equal(await c.isValidRootForHeight(R('c'), 6), false)
  assert.equal(await c.isValidRootForHeight(R('c'), 6), false)
  assert.equal(asks, 4, 'a refusal is never reused')
  // fresh asks the source, has it forget its own cache, and drops the stale entry.
  assert.equal(await c.fresh.isValidRootForHeight(R('b'), 5), false)
  assert.deepEqual(inner.forgot, [5])
  assert.equal(await c.isValidRootForHeight(R('b'), 5), false)
  assert.equal(await c.fresh.currentHeight(), 7)
  assert.equal(tips, 2)
})

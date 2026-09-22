/**
 * Integration tests: the real engine, the real storage layer, this host's own
 * HTTP surface. They run against SQLite rather than MySQL because what is
 * under test is this host's wiring and its contracts, not the database, and a
 * test that needs a server is a test that does not get run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTopics } from './http.js'
import { assertReady, assertNoAdvertiser, AssertionError } from './engine.js'
import { AnyTxLookupService } from './lookup/anytx.js'
import { AnyTxTopicManager } from './topics/anytx.js'
import { Metrics } from './metrics.js'

test('parseTopics accepts both wire forms', () => {
  assert.deepEqual(parseTopics('tm_a,tm_b'), ['tm_a', 'tm_b'])
  assert.deepEqual(parseTopics('["tm_a","tm_b"]'), ['tm_a', 'tm_b'])
  // The generated server's binder does not trim, so a leading space there
  // turns a valid topic into an unknown one. This accepts it.
  assert.deepEqual(parseTopics(' tm_a , tm_b '), ['tm_a', 'tm_b'])
  assert.deepEqual(parseTopics('tm_a,tm_a'), ['tm_a'])
})

test('parseTopics refuses what would lose topics silently', () => {
  assert.throws(() => parseTopics(undefined))
  assert.throws(() => parseTopics(''))
  // A repeated header is read first-value-only by the generated binder, which
  // discards the rest without saying so.
  assert.throws(() => parseTopics(['tm_a', 'tm_b']))
  assert.throws(() => parseTopics('tm_a,,tm_b'))
  assert.throws(() => parseTopics('["tm_a"'))
})

test('startup assertions fail fast on the three silent misconfigurations', () => {
  const managers = { tm_anytx: new AnyTxTopicManager() }
  const base = {
    managers,
    lookupServices: {},
    storage: {} as never,
    chainTracker: {} as never,
    topics: ['tm_anytx'],
  }
  assert.doesNotThrow(() => assertReady(base))

  assert.throws(
    () => assertReady({ ...base, chainTracker: undefined as never }),
    AssertionError,
    'a missing chain tracker must not reach a running engine',
  )
  assert.throws(
    () => assertReady({ ...base, topics: ['tm_anytx', 'tm_anytx'] }),
    AssertionError,
    'a duplicate topic silently keeps the last manager and must be refused',
  )
  assert.throws(
    () => assertReady({ ...base, topics: ['tm_missing'] }),
    AssertionError,
    'a topic with no manager must be refused',
  )
  assert.throws(() => assertNoAdvertiser({}), AssertionError)
  assert.doesNotThrow(() => assertNoAdvertiser(undefined))
})

test('ls_anytx answers a sorted formula, which is what makes two hosts comparable', async () => {
  const ls = new AnyTxLookupService()
  const script = {} as never
  for (const [txid, i] of [['ccc', 1], ['aaa', 0], ['bbb', 2]] as Array<[string, number]>) {
    ls.outputAdmittedByTopic({
      mode: 'locking-script',
      txid,
      outputIndex: i,
      topic: 'tm_anytx',
      satoshis: 1,
      lockingScript: script,
    })
  }
  const all = await ls.lookup({ service: 'ls_anytx', query: { all: true } })
  assert.deepEqual(
    all.map((o) => `${o.txid}.${o.outputIndex}`),
    ['aaa.0', 'bbb.2', 'ccc.1'],
    'the whole-index answer must be sorted, or two hosts agree as sets and differ as lists',
  )
  assert.equal(ls.size, 3)

  const one = await ls.lookup({ service: 'ls_anytx', query: { outpoint: 'bbb.2' } })
  assert.deepEqual(one, [{ txid: 'bbb', outputIndex: 2 }])

  const missing = await ls.lookup({ service: 'ls_anytx', query: { outpoint: 'zzz.9' } })
  assert.deepEqual(missing, [])

  await assert.rejects(() => ls.lookup({ service: 'ls_anytx', query: {} }))
})

test('ls_anytx forgets a spent and an evicted output', async () => {
  const ls = new AnyTxLookupService()
  const script = {} as never
  ls.outputAdmittedByTopic({ mode: 'locking-script', txid: 'a', outputIndex: 0, topic: 't', satoshis: 1, lockingScript: script })
  ls.outputAdmittedByTopic({ mode: 'locking-script', txid: 'b', outputIndex: 0, topic: 't', satoshis: 1, lockingScript: script })
  ls.outputSpent({ mode: 'txid', txid: 'a', outputIndex: 0, topic: 't', spendingTxid: 'x' })
  ls.outputEvicted('b', 0)
  assert.equal(ls.size, 0, 'an evicted output must not appear in any later answer')
})

// Found by restarting a host that had admitted five objects: the engine does
// not replay admissions into a lookup service on start, so the index came back
// empty while the engine still held every output. A parity oracle would have
// read that as the two hosts disagreeing.
test('ls_anytx rebuilds its index from storage, skipping spent outputs', async () => {
  const ls = new AnyTxLookupService()
  const restored = ls.restore([
    { txid: 'aa'.repeat(32), outputIndex: 0, topic: 'tm_anytx', spent: false },
    { txid: 'bb'.repeat(32), outputIndex: 2, topic: 'tm_anytx', spent: false },
    { txid: 'cc'.repeat(32), outputIndex: 0, topic: 'tm_anytx', spent: true },
  ])
  assert.equal(restored, 2)
  assert.equal(ls.size, 2)

  const all = await ls.lookup({ service: 'ls_anytx', query: { all: true } })
  assert.deepEqual(all, [
    { txid: 'aa'.repeat(32), outputIndex: 0 },
    { txid: 'bb'.repeat(32), outputIndex: 2 },
  ])
})

test('tm_anytx refuses rather than throws on an object it cannot parse', async () => {
  const tm = new AnyTxTopicManager()
  const out = await tm.identifyAdmissibleOutputs([1, 2, 3], [])
  assert.deepEqual(out, { outputsToAdmit: [], coinsToRetain: [] },
    'the plane is open, so an unparseable object is the sender\'s problem, not a host fault')
})

test('metrics preset a series at zero so an alert can match it', () => {
  const m = new Metrics()
  m.preset('overlay_host_submits_total', { result: 'ok' })
  assert.match(m.render(), /overlay_host_submits_total\{result="ok"\} 0/)
  m.inc('overlay_host_submits_total', { result: 'ok' })
  assert.match(m.render(), /overlay_host_submits_total\{result="ok"\} 1/)
})

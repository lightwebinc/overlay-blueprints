/**
 * Unit tests: the parts that can be decided without a database.
 *
 * Header parsing, the startup assertions, the lookup index's own behaviour
 * including its restore path, the topic manager's refusal contract, the sync
 * peer parser and metric presetting. No engine is constructed here, no storage
 * is opened and no HTTP server is built.
 *
 * The engine, the storage layer and the HTTP surface are exercised LIVE
 * against MySQL and recorded in docs/proof.md. That split is deliberate: what
 * those need is a real database and a real chain tracker, and a test that
 * faked either would prove the fake.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSyncPeers, ConfigError, loadConfig } from './config.js'
import { parseTopics } from './http.js'
import { assertReady, assertNoAdvertiser, AssertionError, countingLogger } from './engine.js'
import { AnyTxLookupService } from './lookup/anytx.js'
import { AnyTxTopicManager } from './topics/anytx.js'
import { Metrics } from './metrics.js'
import { installedVersions } from './buildinfo.js'

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
  // assertNoAdvertiser now reads the PARTS object rather than a named field,
  // because EngineParts has no advertiser field and adding one to make the
  // check reachable would create the hole it closes.
  assert.throws(() => assertNoAdvertiser({ advertiser: {} }), AssertionError)
  assert.doesNotThrow(() => assertNoAdvertiser({}))
  assert.doesNotThrow(() => assertNoAdvertiser({ advertiser: undefined }))
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

// A peer list that silently dropped a malformed entry would leave a host
// syncing with fewer peers than its operator configured, and the only symptom
// would be data that never arrives.
test('parseSyncPeers refuses rather than filters', () => {
  assert.deepEqual(parseSyncPeers('', ['tm_a']), {})
  assert.deepEqual(parseSyncPeers('tm_a=https://one.example/;tm_b=http://two.example/', ['tm_a', 'tm_b']), {
    tm_a: ['https://one.example/'],
    tm_b: ['http://two.example/'],
  })
  assert.deepEqual(parseSyncPeers('tm_a=https://one.example/,https://two.example/', ['tm_a']), {
    tm_a: ['https://one.example/', 'https://two.example/'],
  })

  for (const bad of [
    'tm_a', // no =
    '=https://one.example/', // no topic
    'tm_zzz=https://one.example/', // a topic this host does not mount
    'tm_a=https://one.example/;tm_a=https://two.example/', // named twice
    'tm_a=', // empty peer
    'tm_a=not a url',
    'tm_a=ftp://one.example/', // not http or https
  ]) {
    assert.throws(() => parseSyncPeers(bad, ['tm_a']), ConfigError, `accepted ${JSON.stringify(bad)}`)
  }
})

// The defect this whole change set turns on: `false` does not mean "no
// background sync, admin sync still available". It means the engine skips the
// topic entirely, on every trigger including the admin one.
test('a topic with no configured peers is false, which the engine skips outright', () => {
  const managers = { tm_a: new AnyTxTopicManager() }
  const parts = {
    managers,
    lookupServices: { ls_anytx: new AnyTxLookupService() },
    storage: {} as never,
    chainTracker: {} as never,
    topics: ['tm_a'],
  }
  // No syncPeers at all.
  assert.doesNotThrow(() => assertReady(parts))

  // And an advertiser arriving through a widened type is refused, although
  // EngineParts has no such field today.
  assert.throws(() => assertReady({ ...parts, advertiser: {} } as never), AssertionError)
})

// startGASPSync catches every per-peer error and carries on, so its return
// says nothing about whether a peer answered. Counting the engine's error
// calls is the only way the host can tell, and without it a catch-up that
// recovered nothing answers 200 — which is exactly what happened the first
// time this was run against a peer serving no GASP routes.
test('the counting logger reads back failures the engine swallows', () => {
  const quiet = { log() {}, info() {}, warn() {}, debug() {}, error() {} } as unknown as typeof console
  const l = countingLogger(quiet)

  assert.equal(l.take(), 0)
  l.error('[GASP SYNC] Sync failed for topic "tm_a" with peer "..."')
  l.error('another peer failed')
  assert.equal(l.take(), 2)
  // take() resets, so a later sync is not judged by an earlier one's failures.
  assert.equal(l.take(), 0)

  l.info('info does not count as a failure')
  assert.equal(l.take(), 0)

  // It DELEGATES rather than reimplementing. The engine's parameter is the
  // whole console interface, and a hand-written stand-in breaks the first time
  // the engine calls a method nobody thought to add. Checked against the real
  // console, because that is what it delegates to in the host; checking it
  // against the five-method stub above would only prove the stub's shape.
  const real = countingLogger()
  assert.equal(typeof real.table, 'function')
  assert.equal(typeof real.group, 'function')
  assert.equal(typeof real.assert, 'function')
  assert.equal(real.take(), 0)
})

/**
 * The lookup cap is what breaks the parity ORACLE, which is C8's acceptance
 * gate. `ls_anytx` answers `{all:true}` with one row per admitted output and
 * offers no pagination, so a host that has been running for an afternoon
 * exceeds the engine's default of 1000 and the oracle gets HTTP 400 from
 * exactly the hosts it exists to compare. Measured live: 3,984 results on one
 * host, 3,919 on the other, both refused.
 *
 * The default must stay the engine's own, because an unbounded lookup is a
 * denial-of-service surface on a public /lookup.
 */
test('OVERLAY_MAX_LOOKUP_RESULTS is unset by default and refuses nonsense', () => {
  const base = {
    OVERLAY_TOPICS: 'tm_a',
    OVERLAY_KNEX_URL: 'mysql://u:p@h/d',
    OVERLAY_CHAIN_TRACKER_URL: 'http://127.0.0.1:9178',
    OVERLAY_ADMIN_TOKEN: 't',
  }
  const saved = { ...process.env }
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('OVERLAY_')) delete process.env[k]
    Object.assign(process.env, base)

    // Unset: the engine keeps its own default, so the host does not quietly
    // widen a DoS surface just by being deployed.
    assert.equal(loadConfig().maxLookupResults, undefined)

    // -1 is the documented opt-out and must be accepted verbatim.
    process.env.OVERLAY_MAX_LOOKUP_RESULTS = '-1'
    assert.equal(loadConfig().maxLookupResults, -1)

    process.env.OVERLAY_MAX_LOOKUP_RESULTS = '50000'
    assert.equal(loadConfig().maxLookupResults, 50000)

    // 0 and -2 are rejected HERE, naming the variable, rather than surfacing
    // as an opaque engine throw at construction time.
    for (const bad of ['0', '-2', '1.5', 'many']) {
      process.env.OVERLAY_MAX_LOOKUP_RESULTS = bad
      assert.throws(() => loadConfig(), ConfigError, `expected ${bad} to be refused`)
    }
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('OVERLAY_')) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

/**
 * build_info must carry the INSTALLED versions, not the manifest's ranges.
 * A sibling component's version skew cost a ninety-minute total object-plane
 * outage that no metric could see, because nothing published what was loaded.
 * A label reading "unknown" would be worse than absent: it looks like an
 * answer.
 */
test('build_info carries installed dependency versions, not ranges', () => {
  const m = new Metrics()
  m.info('overlay_host_build_info', { overlay: '2.3.1', sdk: '2.7.1', gasp: '1.3.6', node: '24.0.0' })
  const out = m.render()
  assert.match(out, /overlay_host_build_info\{.*overlay="2\.3\.1".*\} 1/)
  // Labels render sorted, so the series identity is stable across restarts.
  assert.match(out, /gasp="1\.3\.6",node="24\.0\.0",overlay="2\.3\.1",sdk="2\.7\.1"/)
  // A range is not a version. If this ever renders a caret the reporter is
  // reading package.json instead of what is installed.
  assert.doesNotMatch(out, /[\^~]/)
})

/**
 * The RESOLVER, not a hand-written label set. The first version of this test
 * asserted against hardcoded labels, so it passed while the real reporter
 * returned "unknown" for every package and that is exactly what got deployed.
 *
 * The cause is worth remembering: `require.resolve('<pkg>/package.json')`
 * throws for any package whose `exports` map does not list "./package.json",
 * which is most modern packages. Resolve the ENTRY POINT and walk up instead.
 */
test('installedVersions resolves real versions, never "unknown"', () => {
  const v = installedVersions()
  for (const pkg of ['overlay', 'sdk', 'gasp']) {
    assert.notEqual(v[pkg], 'unknown', `${pkg} resolved to "unknown": the reporter is broken and reads as an answer`)
    assert.match(String(v[pkg]), /^\d+\.\d+\.\d+/, `${pkg} is not a concrete version`)
  }
  assert.match(String(v.node), /^\d+\./)
})

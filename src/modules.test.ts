/**
 * The module loader: parsing, the mount refusals, and a stub module loaded
 * from a temporary file whose manager replaces the default.
 *
 * The stubs are written at test time rather than kept as fixtures, because a
 * fixture module under src/ would be compiled and shipped with the host, and
 * the host is meant to carry no module of its own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TopicManager, LookupService } from '@lightwebinc/overlay'
import { parseModules, ConfigError, loadConfig } from './config.js'
import { loadModules, mountModules, type LoadedModule, type ModuleHost } from './modules.js'
import { AnyTxTopicManager } from './topics/anytx.js'
import { AnyTxLookupService } from './lookup/anytx.js'
import { Metrics } from './metrics.js'

const quiet: ModuleHost = { log: () => {}, metrics: new Metrics() }

function stubManager(): TopicManager {
  return {
    identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [], coinsToRetain: [] }),
    getDocumentation: async () => '',
    getMetaData: async () => ({ name: 'stub', shortDescription: '' }),
  }
}

function stubLookup(): LookupService {
  return {
    admissionMode: 'locking-script',
    spendNotificationMode: 'none',
    outputAdmittedByTopic: () => {},
    outputEvicted: () => {},
    lookup: async () => [],
    getDocumentation: async () => '',
    getMetaData: async () => ({ name: 'stub', shortDescription: '' }),
  }
}

function loadedStub(path: string, topics: string[], lookups: string[]): LoadedModule {
  const module: LoadedModule['module'] = {}
  if (topics.length > 0) module.topics = Object.fromEntries(topics.map((t) => [t, stubManager()]))
  if (lookups.length > 0) module.lookups = Object.fromEntries(lookups.map((l) => [l, stubLookup()]))
  return { path, module }
}

// A module entry dropped silently would leave a topic on the admit-everything
// default while the operator believes it is selective.
test('parseModules refuses rather than filters', () => {
  assert.deepEqual(parseModules(''), [])
  assert.deepEqual(parseModules('   '), [])
  assert.deepEqual(parseModules(' /opt/a/index.js , /opt/b/index.js '), ['/opt/a/index.js', '/opt/b/index.js'])
  for (const bad of [
    '/opt/a/index.js,,/opt/b/index.js', // empty entry
    '/opt/a/index.js,', // trailing empty entry
    'modules/a/index.js', // relative
    './a/index.js', // relative, explicitly
    '/opt/a/index.js,/opt/a/index.js', // twice
  ]) {
    assert.throws(() => parseModules(bad), ConfigError, `accepted ${JSON.stringify(bad)}`)
  }
})

test('OVERLAY_MODULES is empty by default and parsed when set', () => {
  const saved = { ...process.env }
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('OVERLAY_')) delete process.env[k]
    Object.assign(process.env, {
      OVERLAY_TOPICS: 'tm_a',
      OVERLAY_KNEX_URL: 'mysql://u:p@h/d',
      OVERLAY_CHAIN_TRACKER_URL: 'http://127.0.0.1:9178',
      OVERLAY_ADMIN_TOKEN: 't',
    })
    assert.deepEqual(loadConfig().modules, [])
    process.env.OVERLAY_MODULES = '/opt/a/index.js'
    assert.deepEqual(loadConfig().modules, ['/opt/a/index.js'])
    process.env.OVERLAY_MODULES = 'a/index.js'
    assert.throws(() => loadConfig(), ConfigError)
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('OVERLAY_')) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('mountModules refuses a module whose topic OVERLAY_TOPICS does not name', () => {
  const managers: Record<string, TopicManager> = { tm_a: new AnyTxTopicManager() }
  const lookups: Record<string, LookupService> = { ls_anytx: new AnyTxLookupService() }
  assert.throws(
    () => mountModules([loadedStub('/m/x.js', ['tm_zzz'], [])], ['tm_a'], managers, lookups),
    (err: unknown) =>
      err instanceof ConfigError &&
      /mounts topic tm_zzz which OVERLAY_TOPICS does not name/.test(err.message),
  )
  // Nothing was mounted on the way to the refusal.
  assert.ok(managers['tm_a'] instanceof AnyTxTopicManager)
  assert.equal(Object.keys(managers).length, 1)
})

test('mountModules refuses duplicate lookups and duplicate topic claims', () => {
  const fresh = (): [Record<string, TopicManager>, Record<string, LookupService>] => [
    { tm_a: new AnyTxTopicManager(), tm_b: new AnyTxTopicManager() },
    { ls_anytx: new AnyTxLookupService() },
  ]
  // With the host's own service.
  let [managers, lookups] = fresh()
  assert.throws(
    () => mountModules([loadedStub('/m/x.js', ['tm_a'], ['ls_anytx'])], ['tm_a', 'tm_b'], managers, lookups),
    (err: unknown) => err instanceof ConfigError && /lookup ls_anytx which is already mounted/.test(err.message),
  )
  // Across two modules.
  ;[managers, lookups] = fresh()
  assert.throws(
    () =>
      mountModules(
        [loadedStub('/m/x.js', ['tm_a'], ['ls_x']), loadedStub('/m/y.js', ['tm_b'], ['ls_x'])],
        ['tm_a', 'tm_b'],
        managers,
        lookups,
      ),
    (err: unknown) => err instanceof ConfigError && /module \/m\/y.js mounts lookup ls_x/.test(err.message),
  )
  // Two modules claiming one topic: the maps are plain objects and the second
  // would silently win.
  ;[managers, lookups] = fresh()
  assert.throws(
    () =>
      mountModules(
        [loadedStub('/m/x.js', ['tm_a'], []), loadedStub('/m/y.js', ['tm_a'], [])],
        ['tm_a', 'tm_b'],
        managers,
        lookups,
      ),
    (err: unknown) => err instanceof ConfigError && /which module \/m\/x.js already mounts/.test(err.message),
  )
})

test('mountModules replaces the default manager only on claimed topics', () => {
  const managers: Record<string, TopicManager> = { tm_a: new AnyTxTopicManager(), tm_b: new AnyTxTopicManager() }
  const lookups: Record<string, LookupService> = { ls_anytx: new AnyTxLookupService() }
  const stub = loadedStub('/m/x.js', ['tm_a'], ['ls_x'])
  const mounted = mountModules([stub], ['tm_a', 'tm_b'], managers, lookups)
  assert.equal(managers['tm_a'], stub.module.topics?.['tm_a'], 'the module manager must replace the default')
  assert.ok(managers['tm_b'] instanceof AnyTxTopicManager, 'an unclaimed topic keeps the default')
  assert.equal(lookups['ls_x'], stub.module.lookups?.['ls_x'])
  assert.ok(lookups['ls_anytx'] instanceof AnyTxLookupService)
  assert.deepEqual(mounted, [{ path: '/m/x.js', topics: ['tm_a'], lookups: ['ls_x'] }])
})

const STUB = `
export default function create(host) {
  host.log('stub module created')
  host.metrics.preset('stub_total', { kind: 'x' })
  return {
    topics: {
      tm_stub: {
        identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [], coinsToRetain: [] }),
        getDocumentation: async () => '',
        getMetaData: async () => ({ name: 'tm_stub', shortDescription: '' }),
      },
    },
    lookups: {
      ls_stub: {
        admissionMode: 'locking-script',
        spendNotificationMode: 'none',
        outputAdmittedByTopic() {},
        outputEvicted() {},
        async lookup() { return [] },
        async getDocumentation() { return '' },
        async getMetaData() { return { name: 'ls_stub', shortDescription: '' } },
        restore(outputs) { return outputs.length },
      },
    },
  }
}
`

test('loadModules loads a stub module from a file and mounts it over the default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'overlay-modules-'))
  try {
    // .mjs, because a temporary directory has no package.json to declare
    // "type": "module" and a bare .js would be read as CommonJS.
    const path = join(dir, 'stub.mjs')
    await writeFile(path, STUB)
    const logged: string[] = []
    const metrics = new Metrics()
    const loaded = await loadModules([path], { log: (m) => logged.push(m), metrics })
    assert.equal(loaded.length, 1)
    assert.deepEqual(logged, ['stub module created'])
    assert.match(metrics.render(), /stub_total\{kind="x"\} 0/, 'the module counts through the host registry')

    const managers: Record<string, TopicManager> = { tm_stub: new AnyTxTopicManager(), tm_a: new AnyTxTopicManager() }
    const lookups: Record<string, LookupService> = { ls_anytx: new AnyTxLookupService() }
    mountModules(loaded, ['tm_stub', 'tm_a'], managers, lookups)
    assert.ok(!(managers['tm_stub'] instanceof AnyTxTopicManager), 'the default must be replaced')
    assert.equal(managers['tm_stub'], loaded[0]?.module.topics?.['tm_stub'])
    assert.ok(managers['tm_a'] instanceof AnyTxTopicManager)
    const restore = loaded[0]?.module.lookups?.['ls_stub']?.restore
    assert.equal(typeof restore, 'function')
    // The stub ignores the storage it is handed; the contract still hands one.
    assert.equal(await restore?.([{} as never, {} as never], { findOutput: async () => null }), 2)

    // And the same module against a configuration that does not name its
    // topic is refused with the topic in the message.
    assert.throws(
      () => mountModules(loaded, ['tm_a'], { tm_a: new AnyTxTopicManager() }, {}),
      (err: unknown) => err instanceof ConfigError && /tm_stub which OVERLAY_TOPICS does not name/.test(err.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadModules refuses what is not a module, naming the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'overlay-modules-'))
  try {
    const cases: Array<[string, string, RegExp]> = [
      ['notfn.mjs', 'export default 42', /default export is not a create\(host\) function/],
      ['empty.mjs', 'export default () => ({})', /mounts no topics and no lookups/],
      ['badtm.mjs', 'export default () => ({ topics: { tm_x: {} } })', /topic tm_x is not a topic manager/],
      ['badls.mjs', 'export default () => ({ lookups: { ls_x: { lookup() {} } } })', /lookup ls_x is not a lookup service/],
      ['throws.mjs', 'export default () => { throw new Error("boom") }', /create\(host\) failed: boom/],
      ['syntax.mjs', 'export default function (', /could not be loaded/],
    ]
    for (const [name, body, want] of cases) {
      const path = join(dir, name)
      await writeFile(path, body)
      await assert.rejects(
        () => loadModules([path], quiet),
        (err: unknown) => err instanceof ConfigError && want.test(err.message) && err.message.includes(path),
        `expected ${name} to be refused with ${String(want)}`,
      )
    }
    await assert.rejects(
      () => loadModules([join(dir, 'missing.mjs')], quiet),
      (err: unknown) => err instanceof ConfigError && /could not be loaded/.test(err.message),
    )
    await assert.rejects(
      () => loadModules(['relative/stub.mjs'], quiet),
      (err: unknown) => err instanceof ConfigError && /is not absolute/.test(err.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A reference overlay host with the BEEF object plane as its transport.
 *
 * It constructs the released engine directly, with no advertiser, so the
 * engine admits and indexes and never propagates: the plane is the
 * propagation. Delivery reaches it as ordinary submits from the bridge beside
 * it, and its chain tracker is that bridge's header store, so every object it
 * admits is verified against headers the host itself received.
 *
 * It is a reference, not a product. The blueprint applications are separate.
 */
import { loadConfig, ConfigError } from './config.js'
import { openStorage } from './storage.js'
import { chainTrackerFor } from './headersource.js'
import { CachedChainTracker } from './chaintracker.js'
import { buildEngine, AssertionError, countingLogger } from './engine.js'
import { AnyTxTopicManager } from './topics/anytx.js'
import { AnyTxLookupService, KnexOutpointStore } from './lookup/anytx.js'
import { Metrics } from './metrics.js'
import { installedVersions } from './buildinfo.js'
import { buildServer, submitBEEF, type HttpDeps } from './http.js'
import { loadModules, mountModules, ModuleRoutes, type ModuleHost } from './modules.js'
import { unspentOutputs } from './restore.js'
import { KnexProofIndex, watchReorgs, type ReorgEvent } from './reorg.js'
import { VerifyPool, defaultWorkers } from './verifypool.js'

/** Script verification buckets, 0.1 ms to 100 ms: the target is under 1 ms. */
const VERIFY_BUCKETS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1]
import type { Engine, TopicManager, LookupService, Output } from '@lightwebinc/overlay'

function log(msg: string, extra: Record<string, unknown> = {}): void {
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`)
  console.log([new Date().toISOString(), msg, ...parts].join(' '))
}

/** Calls each listener in turn, logging rather than throwing what one throws. */
async function notify<A extends unknown[]>(
  what: string,
  listeners: ReadonlyArray<(...a: A) => void | Promise<void>>,
  timeoutMs: number,
  ...args: A
): Promise<void> {
  for (const l of listeners) {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => l(...args)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
          timer.unref()
        }),
      ])
    } catch (err) {
      log(`${what} listener failed`, { err: String(err) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  log('overlay host starting', { topics: cfg.topics.join(','), port: cfg.port })

  const { db, storage } = await openStorage(cfg.knexUrl)
  log('storage migrated')

  // The engine asks for the tip on every admission and for a root on every
  // proven transaction; the cache answers repeats for a moment, and `fresh`
  // (readiness, the reorg watch, re-checking a stored proof) always asks.
  const chainTracker = new CachedChainTracker(chainTrackerFor(cfg.chainTrackerUrl, cfg.chainNetwork))

  // Script verification on worker threads, before anything can verify.
  const workers = cfg.verifyWorkers ?? defaultWorkers()
  // With no workers the pool runs the same interpreter inline, so every
  // verification is timed and counted whichever path it takes.
  const pool = new VerifyPool(workers)
  pool.install()
  log('script verification', { workers: workers === 0 ? 'inline' : workers })

  // Created before the modules load, because a module presets and counts
  // through it from its factory onwards, and a second registry would be a
  // second /metrics to scrape.
  const metrics = new Metrics()

  const managers: Record<string, TopicManager> = {}
  const lookupServices: Record<string, LookupService> = {}
  // ls_anytx reads the engine's storage at question time: there is no index
  // to rebuild, so a host with any number of outputs starts at once.
  const index = new AnyTxLookupService(new KnexOutpointStore(db, cfg.topics))
  for (const t of cfg.topics) {
    managers[t] = new AnyTxTopicManager()
  }
  lookupServices['ls_anytx'] = index

  // What modules are handed. The engine does not exist until every module
  // has returned its managers, so its calls are bound late and refuse until
  // the host has started.
  let engine: Engine | undefined
  let httpDeps: HttpDeps | undefined
  const routes = new ModuleRoutes()
  const reorgListeners: Array<(e: ReorgEvent) => void | Promise<void>> = []
  const shutdownListeners: Array<() => void | Promise<void>> = []
  const started = (): { engine: Engine; deps: HttpDeps } => {
    if (engine === undefined || httpDeps === undefined) throw new Error('the host has not started yet')
    return { engine, deps: httpDeps }
  }
  const hostFor = (path: string): ModuleHost => ({
    log,
    metrics,
    chainTracker,
    storage,
    engine: {
      submit: async (beef, topics) => {
        const { deps } = started()
        const unknown = topics.filter((t) => !cfg.topics.includes(t))
        if (unknown.length > 0) throw new Error(`this host does not carry: ${unknown.join(', ')}`)
        return await submitBEEF(deps, beef, topics)
      },
      evict: async (txid, options = {}) => {
        const r = await started().engine.evictAppliedTransaction(txid, options)
        return { evictedTransactions: r.evictedTransactions, evictedOutputs: r.evictedOutputs }
      },
    },
    route: routes.forModule(path),
    onReorg: (l) => {
      reorgListeners.push(l)
    },
    onShutdown: (l) => {
      shutdownListeners.push(l)
    },
  })

  // Modules load after storage and before the engine: a module's manager
  // replaces the default on the topics it claims, so the engine must never
  // see the default there, and a module that fails to load must stop the
  // host before it admits anything under the wrong manager.
  const loaded = await loadModules(cfg.modules, hostFor)
  const mounted = mountModules(loaded, cfg.topics, managers, lookupServices)
  for (const m of mounted) {
    log('module loaded', { path: m.path, topics: m.topics.join(','), lookups: m.lookups.join(',') })
  }
  for (const r of routes.mount(loaded)) log('module route mounted', { path: r })

  const syncErrors = countingLogger()
  engine = buildEngine({
    managers,
    lookupServices,
    maxLookupResults: cfg.maxLookupResults,
    storage,
    chainTracker,
    topics: cfg.topics,
    syncPeers: cfg.syncPeers,
    logger: syncErrors,
  })
  const peered = Object.values(cfg.syncPeers).filter((u) => u.length > 0).length
  log('engine built with no advertiser: propagation is off', {
    topicsWithCatchupPeers: peered,
  })
  if (peered === 0) {
    // Said out loud at startup, because the consequence is a silent one: the
    // admin catch-up route will return success having done nothing.
    log('no catch-up peers configured: /admin/startGASPSync will be a no-op')
  }

  // Every module lookup that can rebuild itself is fed the unspent outputs
  // of the topics that module declares, each with its BEEF (a module may read
  // what a stored transaction spent, and not only what its script says),
  // read a page at a time. A lookup with `restoreFrom` takes them one at a
  // time; one with only `restore` takes an array, whose BEEF stay bytes
  // until read. The real storage object goes through: a restore that must
  // know who spent an output the unspent rows do not carry asks it directly.
  for (const { path, module } of loaded) {
    const restorable = Object.entries(module.lookups ?? {}).filter(
      ([, ls]) => typeof ls.restoreFrom === 'function' || typeof ls.restore === 'function',
    )
    if (restorable.length === 0) continue
    const topics = Object.keys(module.topics ?? {})
    let array: Output[] | undefined
    for (const [name, ls] of restorable) {
      let n: number
      if (typeof ls.restoreFrom === 'function') {
        n = await ls.restoreFrom(unspentOutputs(db, topics, { includeBEEF: true }), storage)
      } else {
        if (array === undefined) {
          array = []
          for await (const o of unspentOutputs(db, topics, { includeBEEF: true, lazyBEEF: true })) array.push(o)
        }
        n = (await ls.restore?.(array, storage)) ?? 0
      }
      log('module lookup restored from storage', { path, lookup: name, outputs: n })
    }
  }

  // Readiness: storage answers and the chain tracker answers. Both are
  // re-checked rather than cached, because a host that came up healthy and
  // lost its chain tracker is not ready and should say so.
  let lastReady = false
  const ready = (): boolean => lastReady
  const probe = async (): Promise<void> => {
    try {
      await db.raw('select 1')
      await chainTracker.fresh.currentHeight()
      lastReady = true
    } catch (err) {
      if (lastReady) log('readiness lost', { err: String(err) })
      lastReady = false
    }
  }
  await probe()
  const probeTimer = setInterval(() => void probe(), 10_000)
  probeTimer.unref()

  // The reason this host runs a forked engine.
  //
  // Upstream's `submit` catches every per-topic validation error into a local
  // set and still returns an EMPTY admittance instruction for that topic, with
  // HTTP 200. A failure, a duplicate and a legitimate empty admission are then
  // byte-identical to us, so a host admitting nothing reads exactly like a
  // quiet plane and the only available alert is a long absence-of-admissions
  // conjunction. With the fork's reporter a single failed admission is a
  // counter, and therefore alertable on the first occurrence.
  //
  // The topic is a label; the error is NOT. An error string is unbounded,
  // attacker-influenced through the object it came from, and would make this
  // series a cardinality bomb. It goes to the log, where it belongs.
  for (const t of cfg.topics) {
    metrics.preset('overlay_host_topic_failures_total', { topic: t })
  }
  engine.onTopicFailed = (topic, error) => {
    metrics.inc('overlay_host_topic_failures_total', { topic })
    log('topic admission FAILED', { topic, err: String(error) })
  }

  metrics.info('overlay_host_build_info', installedVersions())
  // Counted by a query, so refreshed in the background rather than on scrape.
  const recount = (): void => {
    index.refreshSize().catch((err: unknown) => log('outpoint count failed', { err: String(err) }))
  }
  recount()
  const recountTimer = setInterval(recount, 60_000)
  recountTimer.unref()
  metrics.gauge('overlay_host_indexed_outputs', () => index.size)
  metrics.gauge('overlay_host_ready', () => (lastReady ? 1 : 0))
  metrics.gauge('overlay_host_verify_workers', () => pool.size)
  metrics.gauge('overlay_host_verify_in_flight', () => pool.inFlight)
  // Kept for the dashboards that read it; worker-path verifications only.
  metrics.counter('overlay_host_verified_in_workers_total', () => (pool.size > 0 ? pool.verified : 0))
  // End to end per script verification, queueing in the pool included.
  for (const result of ['ok', 'refused', 'error']) {
    metrics.histogram('overlay_host_verify_duration_seconds', { path: pool.path, result }, VERIFY_BUCKETS)
  }
  metrics.preset('overlay_host_verify_refused_total', { path: pool.path })
  pool.onVerified = (seconds, result, path) => {
    metrics.observe('overlay_host_verify_duration_seconds', { path, result }, seconds)
    if (result === 'refused') metrics.inc('overlay_host_verify_refused_total', { path })
  }

  // The reorg watch: blocks this host holds proofs in that left the best
  // chain demote those admissions and are told to the modules.
  metrics.preset('overlay_host_reorg_blocks_total')
  metrics.preset('overlay_host_reorg_demoted_total')
  const stopWatch = watchReorgs(
    {
      proofs: new KnexProofIndex(db),
      storage,
      fresh: chainTracker.fresh,
      topics: cfg.topics,
      depth: cfg.reorgDepth,
      log,
      onReorg: async (e) => {
        metrics.inc('overlay_host_reorg_blocks_total', {}, e.disconnected.length)
        metrics.inc('overlay_host_reorg_demoted_total', {}, e.demoted.length)
        await notify('reorg', reorgListeners, 30_000, e)
      },
    },
    cfg.reorgPollSeconds * 1000,
  )
  log('reorg watch', { depth: cfg.reorgDepth, everySeconds: cfg.reorgPollSeconds })

  httpDeps = {
    engine,
    metrics,
    adminToken: cfg.adminToken,
    topics: cfg.topics,
    syncPeers: cfg.syncPeers,
    syncErrors,
    ready,
    log,
    routes,
    freshTracker: chainTracker.fresh,
  }
  const server = buildServer(httpDeps)
  server.listen(cfg.port, cfg.listen, () => {
    log('listening', { addr: `${cfg.listen}:${cfg.port}`, ready: lastReady })
  })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log('stopping', { signal })
    // Do not wait for ever on a module or a connection that will not finish.
    setTimeout(() => process.exit(0), 15_000).unref()
    stopWatch()
    clearInterval(probeTimer)
    clearInterval(recountTimer)
    void notify('shutdown', shutdownListeners, 5_000).then(() => {
      server.close(() => {
        // A query still in flight is aborted by the destroy, and that is not
        // a reason to keep the process up.
        void Promise.allSettled([db.destroy(), pool.close()]).then(() => process.exit(0))
      })
      server.closeIdleConnections()
    })
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof AssertionError) {
    // A misconfiguration is not a stack trace. Say what is wrong and stop
    // before the port opens.
    console.error(`overlay host: ${err.message}`)
    process.exit(2)
  }
  console.error('overlay host: failed to start')
  console.error(err)
  process.exit(1)
})


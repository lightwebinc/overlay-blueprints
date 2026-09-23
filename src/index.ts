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
import { BridgeChainTracker } from './chaintracker.js'
import { buildEngine, AssertionError, countingLogger } from './engine.js'
import { AnyTxTopicManager } from './topics/anytx.js'
import { AnyTxLookupService } from './lookup/anytx.js'
import { Metrics } from './metrics.js'
import { installedVersions } from './buildinfo.js'
import { buildServer } from './http.js'
import type { TopicManager, LookupService } from '@lightwebinc/overlay'

function log(msg: string, extra: Record<string, unknown> = {}): void {
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`)
  console.log([new Date().toISOString(), msg, ...parts].join(' '))
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  log('overlay host starting', { topics: cfg.topics.join(','), port: cfg.port })

  const { db, storage } = await openStorage(cfg.knexUrl)
  log('storage migrated')

  const chainTracker = new BridgeChainTracker(cfg.chainTrackerUrl)

  const managers: Record<string, TopicManager> = {}
  const lookupServices: Record<string, LookupService> = {}
  const index = new AnyTxLookupService()
  for (const t of cfg.topics) {
    managers[t] = new AnyTxTopicManager()
  }
  lookupServices['ls_anytx'] = index

  const syncErrors = countingLogger()
  const engine = buildEngine({
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

  // Rebuild the lookup index from storage BEFORE the port opens. The engine
  // holds admitted outputs durably but does not replay past admissions into a
  // lookup service on start, so without this a restarted host answers an
  // authoritative empty set while still holding every output, and a parity
  // oracle reads an ordinary restart as two hosts disagreeing.
  let restored = 0
  for (const t of cfg.topics) {
    restored += index.restore(await storage.findUTXOsForTopic(t))
  }
  log('lookup index restored from storage', { outputs: restored })

  // Readiness: storage answers and the chain tracker answers. Both are
  // re-checked rather than cached, because a host that came up healthy and
  // lost its chain tracker is not ready and should say so.
  let lastReady = false
  const ready = (): boolean => lastReady
  const probe = async (): Promise<void> => {
    try {
      await db.raw('select 1')
      await chainTracker.currentHeight()
      lastReady = true
    } catch (err) {
      if (lastReady) log('readiness lost', { err: String(err) })
      lastReady = false
    }
  }
  await probe()
  const probeTimer = setInterval(() => void probe(), 10_000)
  probeTimer.unref()

  const metrics = new Metrics()
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
  metrics.gauge('overlay_host_indexed_outputs', () => index.size)
  metrics.gauge('overlay_host_ready', () => (lastReady ? 1 : 0))

  const server = buildServer({
    engine,
    metrics,
    adminToken: cfg.adminToken,
    topics: cfg.topics,
    syncPeers: cfg.syncPeers,
    syncErrors,
    ready,
    log,
  })
  server.listen(cfg.port, cfg.listen, () => {
    log('listening', { addr: `${cfg.listen}:${cfg.port}`, ready: lastReady })
  })

  const stop = (signal: string): void => {
    log('stopping', { signal })
    server.close(() => {
      void db.destroy().then(() => process.exit(0))
    })
    // Do not wait for ever on a connection that will not close.
    setTimeout(() => process.exit(0), 10_000).unref()
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


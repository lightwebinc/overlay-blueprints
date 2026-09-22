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
import { buildEngine, AssertionError } from './engine.js'
import { AnyTxTopicManager } from './topics/anytx.js'
import { AnyTxLookupService } from './lookup/anytx.js'
import { Metrics } from './metrics.js'
import { buildServer } from './http.js'
import type { TopicManager, LookupService } from '@bsv/overlay'

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

  const engine = buildEngine({
    managers,
    lookupServices,
    storage,
    chainTracker,
    topics: cfg.topics,
    syncPeers: cfg.syncPeers,
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
  metrics.gauge('overlay_host_indexed_outputs', () => index.size)
  metrics.gauge('overlay_host_ready', () => (lastReady ? 1 : 0))

  const server = buildServer({
    engine,
    metrics,
    adminToken: cfg.adminToken,
    topics: cfg.topics,
    syncPeers: cfg.syncPeers,
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

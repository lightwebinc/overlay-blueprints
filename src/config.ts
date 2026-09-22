/**
 * Configuration, entirely from the environment.
 *
 * Secrets reach this host through an `EnvironmentFile=` on the VM, mode 0600
 * and owned by the service user, which the unit references. Nothing sensitive
 * is ever written into this repository, and these hosts are built out of band
 * and never converged, so there is no fleet mechanism to inherit instead.
 */

export interface Config {
  /** HTTP listen address for submit, lookup, health and metrics. */
  readonly listen: string
  readonly port: number
  /** knex connection string for the engine's own storage. */
  readonly knexUrl: string
  /**
   * Base URL of the bridge's header read API, which is this host's chain
   * tracker. There is no default on purpose: a default here would quietly
   * send a host's verification questions to a third party.
   */
  readonly chainTrackerUrl: string
  /** Topic names this host mounts. */
  readonly topics: readonly string[]
  /**
   * Bearer token for the admin surface. Required, with no default: the admin
   * surface can trigger catch-up, and an unauthenticated one on a host that
   * holds a topic's state is not a thing to make easy to leave off.
   */
  readonly adminToken: string
  /**
   * Catch-up peers, per topic. Empty by default, which means this host never
   * syncs with anyone.
   *
   * These are EXPLICIT URLs, never discovered. The engine also accepts the
   * string 'SHIP' here, which would make it resolve peers through the
   * discovery overlays; this host does not offer that, because it holds no
   * advertiser and reaching the public SLAP trackers to find a peer is exactly
   * the outbound behaviour the quiet posture exists to remove.
   *
   * A topic absent from this map is configured `false`, and the engine SKIPS
   * it outright in `startGASPSync`. That is worth stating plainly because it
   * is a silent no-op, not an error: an admin trigger against a host with no
   * peers configured returns success having done nothing at all.
   */
  readonly syncPeers: Readonly<Record<string, readonly string[]>>
  readonly logTime: boolean
}

class ConfigError extends Error {}

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') {
    throw new ConfigError(`${name} is required (set it in the unit's EnvironmentFile)`)
  }
  return v.trim()
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v.trim() === '' ? fallback : v.trim()
}

/**
 * Parses `topic=url[,url...][;topic=url...]`.
 *
 * Refuses rather than filters. A peer list that silently dropped a malformed
 * entry would leave a host quietly syncing with fewer peers than its operator
 * configured, and the only symptom would be data that never arrives.
 */
export function parseSyncPeers(raw: string, topics: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (raw.trim() === '') return out
  for (const group of raw.split(';')) {
    if (group.trim() === '') continue
    const eq = group.indexOf('=')
    if (eq <= 0) {
      throw new ConfigError(`OVERLAY_SYNC_PEERS: "${group.trim()}" is not topic=url`)
    }
    const topic = group.slice(0, eq).trim()
    if (!topics.includes(topic)) {
      throw new ConfigError(
        `OVERLAY_SYNC_PEERS names topic "${topic}", which this host does not mount`,
      )
    }
    if (out[topic] !== undefined) {
      throw new ConfigError(`OVERLAY_SYNC_PEERS names topic "${topic}" twice`)
    }
    const urls = group
      .slice(eq + 1)
      .split(',')
      .map((u) => u.trim())
    if (urls.length === 0 || urls.some((u) => u === '')) {
      throw new ConfigError(`OVERLAY_SYNC_PEERS: topic "${topic}" has an empty peer URL`)
    }
    for (const u of urls) {
      let parsed: URL
      try {
        parsed = new URL(u)
      } catch {
        throw new ConfigError(`OVERLAY_SYNC_PEERS: "${u}" is not a URL`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConfigError(`OVERLAY_SYNC_PEERS: "${u}" is not http or https`)
      }
    }
    out[topic] = urls
  }
  return out
}

export function loadConfig(): Config {
  const topics = optional('OVERLAY_TOPICS', '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
  if (topics.length === 0) {
    throw new ConfigError('OVERLAY_TOPICS is required: this host mounts no topics without it')
  }
  const port = Number(optional('OVERLAY_PORT', '8080'))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`OVERLAY_PORT ${port} is not a port`)
  }
  return {
    listen: optional('OVERLAY_LISTEN', '0.0.0.0'),
    port,
    knexUrl: required('OVERLAY_KNEX_URL'),
    chainTrackerUrl: required('OVERLAY_CHAIN_TRACKER_URL'),
    topics,
    adminToken: required('OVERLAY_ADMIN_TOKEN'),
    syncPeers: parseSyncPeers(optional('OVERLAY_SYNC_PEERS', ''), topics),
    logTime: optional('OVERLAY_LOG_TIME', 'false') === 'true',
  }
}

export { ConfigError }

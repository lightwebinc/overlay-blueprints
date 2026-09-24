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
  /**
   * Cap on lookup results the engine hydrates per request; -1 opts out.
   *
   * Left at the engine's own default (1000) unless set. It is configurable
   * because the parity oracle's `{all:true}` question returns one row per
   * admitted output, so the gate that proves two hosts agree object-for-object
   * is the first thing the cap breaks.
   */
  readonly maxLookupResults?: number
  /**
   * Host-side modules, as absolute paths to compiled ES modules. Empty by
   * default. Each must default-export `create(host)` and returns the topic
   * managers and lookup services it mounts; see src/modules.ts for the
   * contract and docs/configuration.md for the operator's view.
   */
  readonly modules: readonly string[]
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

/**
 * Parses the lookup-result cap. Empty means "leave the engine's default
 * alone", which is the safe posture; -1 means unbounded, which a public host
 * should not choose. Anything else must be a positive integer, because the
 * engine rejects the rest at construction and a config error caught here names
 * the variable instead of surfacing as an opaque engine throw at startup.
 */
function parseMaxLookupResults(raw: string): number | undefined {
  const v = raw.trim()
  if (v === '') return undefined
  const n = Number(v)
  if (!Number.isSafeInteger(n) || (n !== -1 && n < 1)) {
    throw new ConfigError(
      `OVERLAY_MAX_LOOKUP_RESULTS ${raw} is not -1 or a positive integer`,
    )
  }
  return n
}

/**
 * Parses `OVERLAY_MODULES`, a comma list of absolute paths.
 *
 * Refuses rather than filters, for the same reason the peer parser does: a
 * module entry dropped silently would leave a topic on the default
 * admit-everything manager while the operator believes it is selective. A
 * relative path is refused too, because it would resolve against wherever the
 * process started, which is not something an operator can read off the unit.
 */
export function parseModules(raw: string): string[] {
  const out: string[] = []
  if (raw.trim() === '') return out
  for (const entry of raw.split(',')) {
    const path = entry.trim()
    if (path === '') throw new ConfigError('OVERLAY_MODULES contains an empty entry')
    if (!path.startsWith('/')) throw new ConfigError(`OVERLAY_MODULES: "${path}" is not an absolute path`)
    if (out.includes(path)) throw new ConfigError(`OVERLAY_MODULES names "${path}" twice`)
    out.push(path)
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
    maxLookupResults: parseMaxLookupResults(optional('OVERLAY_MAX_LOOKUP_RESULTS', '')),
    modules: parseModules(optional('OVERLAY_MODULES', '')),
  }
}

export { ConfigError }

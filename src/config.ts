/**
 * Configuration, entirely from the environment.
 *
 * Secrets reach this host through an `EnvironmentFile=` on the VM, mode 0600
 * and owned by the service user, which the unit references and the demo script
 * reads. Nothing sensitive is ever written into this repository, and these
 * hosts are built out of band and never converged, so there is no fleet
 * mechanism to inherit instead.
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
    logTime: optional('OVERLAY_LOG_TIME', 'false') === 'true',
  }
}

export { ConfigError }

import { Engine, type TopicManager, type LookupService, type Storage } from '@bsv/overlay'
import type { ChainTracker } from '@bsv/sdk'

export class AssertionError extends Error {}

export interface EngineParts {
  readonly managers: Record<string, TopicManager>
  readonly lookupServices: Record<string, LookupService>
  readonly storage: Storage
  readonly chainTracker: ChainTracker
  readonly topics: readonly string[]
  /**
   * Explicit catch-up peers per topic. A topic absent here is configured
   * `false` and the engine skips it in `startGASPSync`.
   */
  readonly syncPeers?: Readonly<Record<string, readonly string[]>>
  /** Optional console the engine logs through; see CountingLogger. */
  readonly logger?: typeof console
}

/**
 * Build the engine in the plane posture: propagation OFF, by having no
 * advertiser at all.
 *
 * This is D3a route 1, and it is the clean one. The engine skips its
 * propagation step outright when no advertiser is configured, so nothing is
 * attempted and nothing is logged. The other supported posture, an empty SLAP
 * tracker list on a stock server, reaches the propagation step, fails to
 * resolve any peer and records that failure on every submission that admits an
 * output. Both leave nothing propagated; only this one is quiet.
 *
 * The constructor takes twenty positional parameters and its own doc comment
 * lists them in the WRONG order. The call below is written from the signature,
 * with every optional slot named in a comment, because a silent
 * mis-positioning here would put the broadcaster where the ship trackers go.
 */
export function buildEngine(p: EngineParts): Engine {
  assertReady(p)
  // Per topic: a list of explicit peer URLs, or `false`.
  //
  // `false` does NOT mean "no background sync, admin sync still available". It
  // means the engine SKIPS the topic entirely: `startGASPSync` reads the value
  // and does `if (configuredEndpoints === false) continue`, and that is the
  // same code path the admin route drives. A host with every topic `false` has
  // an admin trigger that returns success having done nothing, silently. This
  // was measured, not reasoned about: the route was recorded as "proven" on
  // the strength of a 200 and a counter, both of which a no-op produces.
  //
  // The third value the engine accepts, the string 'SHIP', is deliberately not
  // offered: it resolves peers through the public discovery overlays, which is
  // exactly the outbound behaviour a host with no advertiser exists to avoid.
  const syncConfiguration: Record<string, false | string[]> = {}
  for (const t of p.topics) {
    const peers = p.syncPeers?.[t]
    syncConfiguration[t] = peers !== undefined && peers.length > 0 ? [...peers] : false
  }
  return new Engine(
    p.managers,
    p.lookupServices,
    p.storage,
    p.chainTracker,
    undefined, // hostingURL: nothing is advertised, so there is nothing to host at
    [], // shipTrackers: explicitly empty, never the public defaults
    [], // slapTrackers: explicitly empty, never the public defaults
    undefined, // broadcaster
    undefined, // advertiser: THE posture. No advertiser, no propagation.
    syncConfiguration,
    false, // logTime
    undefined, // logPrefix
    undefined, // throwOnBroadcastFailure
    undefined, // overlayBroadcastFacilitator
    p.logger, // logger: the ONLY way to see a per-peer sync failure, see below
  )
}

/** Reads back per-peer sync failures the engine swallowed. */
export interface SyncErrorCounter {
  take: () => number
}

/**
 * A console the host can read failures back out of.
 *
 * `startGASPSync` catches every per-peer error, logs it and carries on, so its
 * return value says nothing about whether anything synced. Without this the
 * admin route answers 200 while every peer failed, which is the same defect as
 * answering 200 while no peer is configured: a success that was never earned.
 *
 * It DELEGATES to the real console rather than reimplementing it: the engine's
 * parameter is `typeof console`, which is a wide interface, and a hand-written
 * stand-in would break the first time the engine called a method nobody
 * thought to add.
 *
 * It COUNTS rather than parses. Any `error` during a sync is a failed peer,
 * and matching on the message text would break the first time upstream
 * reworded it.
 */
export function countingLogger(out: typeof console = console): typeof console & SyncErrorCounter {
  let errors = 0
  const logger = Object.create(out) as typeof console & SyncErrorCounter
  logger.error = (...a: unknown[]): void => {
    errors++
    out.error(...a)
  }
  logger.take = (): number => {
    const n = errors
    errors = 0
    return n
  }
  return logger
}

/**
 * Fail fast, before the port opens, on the three configurations that would
 * otherwise look healthy and be wrong.
 */
export function assertReady(p: EngineParts): void {
  if (p.chainTracker === undefined || p.chainTracker === null) {
    throw new AssertionError(
      'no chain tracker: the engine would verify against nothing, or against a public default',
    )
  }
  const seen = new Set<string>()
  for (const name of p.topics) {
    if (seen.has(name)) {
      // managers and lookupServices are plain objects keyed by topic name, so
      // a duplicate silently keeps the last value with no error at all.
      throw new AssertionError(`topic ${name} is configured twice`)
    }
    seen.add(name)
    if (p.managers[name] === undefined) {
      throw new AssertionError(`topic ${name} has no topic manager`)
    }
  }
  for (const name of Object.keys(p.managers)) {
    if (!seen.has(name)) {
      throw new AssertionError(`topic manager ${name} is mounted but not configured`)
    }
  }
  assertNoAdvertiser(p)
}

/**
 * Refuse an advertiser.
 *
 * `EngineParts` has no advertiser field, so today this cannot fire: passing
 * one is a type error. That is the point, and it is also why this is called
 * from `assertReady` on the raw object rather than on a named field. Adding
 * the field to make the check reachable would create the very hole the design
 * closes. Someone extending `EngineParts` later, though, will add fields
 * without reading this file, and an advertiser that arrives by a widened type
 * or an untyped spread has no symptom: the host keeps working and quietly
 * starts propagating, which is visible only in a traffic capture nobody is
 * taking.
 */
export function assertNoAdvertiser(parts: unknown): void {
  if (typeof parts !== 'object' || parts === null) return
  const advertiser = (parts as Record<string, unknown>)['advertiser']
  if (advertiser !== undefined && advertiser !== null) {
    throw new AssertionError(
      'an advertiser is configured: this host runs with none, because the plane is the propagation',
    )
  }
}

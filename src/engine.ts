import { Engine, type TopicManager, type LookupService, type Storage } from '@bsv/overlay'
import type { ChainTracker } from '@bsv/sdk'

export class AssertionError extends Error {}

export interface EngineParts {
  readonly managers: Record<string, TopicManager>
  readonly lookupServices: Record<string, LookupService>
  readonly storage: Storage
  readonly chainTracker: ChainTracker
  readonly topics: readonly string[]
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
  const syncConfiguration: Record<string, false> = {}
  for (const t of p.topics) {
    // false = do not sync this topic with anyone. Catch-up is triggered
    // deliberately through the admin surface, never as a background habit
    // that would quietly reach the public discovery overlays.
    syncConfiguration[t] = false
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
  )
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
}

/**
 * Refuse an advertiser. The posture is a property of this host, so a caller
 * that passes one has misunderstood what it is for, and finding that out at
 * startup is much cheaper than finding it in a propagation capture.
 */
export function assertNoAdvertiser(advertiser: unknown): void {
  if (advertiser !== undefined && advertiser !== null) {
    throw new AssertionError(
      'an advertiser is configured: this host runs with none, because the plane is the propagation',
    )
  }
}

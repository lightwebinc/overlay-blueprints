/**
 * Host-side modules: topic managers and lookup services loaded by path.
 *
 * The host mounts `tm_anytx` on every configured topic and `ls_anytx` beside
 * it, and that is the whole of what this repository knows about any topic. An
 * application that needs a real topic manager, one that decides what belongs
 * in its topic, lives in its own repository and arrives here as a compiled ES
 * module named in `OVERLAY_MODULES`. The host stays a reference host and
 * carries no application material; the module carries no engine wiring.
 *
 * A module is loaded from an absolute path and must default-export a factory
 * `create(host)`. It is handed the host's logger, metrics, chain tracker,
 * storage and engine calls, a way to mount routes and to hear of reorgs and
 * of shutdown (ModuleHost below), and returns the topic managers and lookup
 * services it mounts. Its topic names must be ones
 * `OVERLAY_TOPICS` already names, so an operator can see from the environment
 * alone which topics a host carries; the module's manager then REPLACES the
 * default `tm_anytx` on that topic. Its lookup names must be new.
 *
 * Every mismatch is a `ConfigError` and stops startup before the port opens.
 * A module that silently failed to mount would leave `tm_anytx` admitting
 * everything on a topic the operator believes is selective, which is the
 * worst kind of wrong: the host looks healthier than the correct one.
 */
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChainTracker, STEAK } from '@bsv/sdk'
import type { TopicManager, LookupService, Output } from '@lightwebinc/overlay'
import { ConfigError } from './config.js'
import type { ReorgEvent } from './reorg.js'

export type { ReorgEvent, DisconnectedBlock } from './reorg.js'

/** Answers a request under a route a module mounted. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * What a module may ask of the engine. Both calls work once the host has
 * started (after every module's restore); before that they throw.
 *
 * Neither may be awaited from inside an engine callback (a topic manager's
 * `identifyAdmissibleOutputs`, a lookup service's `outputAdmittedByTopic`):
 * the engine is part way through a submission there, and waiting on another
 * one from inside it can wait for ever.
 */
export interface ModuleEngine {
  /**
   * Submits a BEEF to the host's own topics, exactly as `POST /submit` does
   * (the same metrics, and a proof it carries for a transaction already held
   * is ingested). For a module that keeps an object the host refused for
   * now (a block not yet in its headers) and offers it again later.
   */
  submit: (beef: number[], topics: readonly string[]) => Promise<STEAK>
  /**
   * Forgets that a transaction was admitted on one topic (or every topic):
   * its outputs are deleted, every lookup service is told `outputEvicted`,
   * and the engine's record of the admission goes, so the same object
   * offered again is decided afresh. The engine's `evictAppliedTransaction`.
   */
  evict: (txid: string, options?: { topic?: string; reason?: string }) => Promise<{
    evictedTransactions: number
    evictedOutputs: number
  }>
}

/** What a host hands a module at load time. */
export interface ModuleHost {
  log: (msg: string, extra?: Record<string, unknown>) => void
  metrics: {
    inc: (name: string, labels?: Record<string, string>, by?: number) => void
    preset: (name: string, labels?: Record<string, string>) => void
    gauge: (name: string, fn: () => number) => void
  }
  /**
   * The headers the engine verifies against: the host's own source, so a
   * module checking a proof the engine does not (an ancestor's) needs no
   * second header configuration.
   */
  chainTracker: ChainTracker
  /** The engine's storage, as a restore is handed it. */
  storage: RestoreStorage
  engine: ModuleEngine
  /**
   * Serves `handler` for every method at `path` and below it, on the host's
   * own listener. `path` is `/<lookup>/<name>` for a lookup service this
   * module mounts (`/ls_bchat/watch`), so two modules cannot collide and no
   * module can shadow a host route. A path that breaks the rule stops the
   * host before its port opens. The handler reads the body itself and owns
   * the response, so it may stream.
   */
  route: (path: string, handler: RouteHandler) => void
  /**
   * Called when blocks this host holds proven admissions in leave the best
   * chain, after those admissions are demoted to unproven (see reorg.ts).
   */
  onReorg: (listener: (e: ReorgEvent) => void | Promise<void>) => void
  /**
   * Called once when the host is asked to stop, before the listener closes
   * and the database is released, each awaited for at most five seconds.
   */
  onShutdown: (listener: () => void | Promise<void>) => void
}

/**
 * The storage a restore is handed and `ModuleHost.storage`: the engine's
 * own `KnexStorage`, narrowed to the calls a module makes.
 *
 * - `findOutput` reads an output that is NOT among the unspent rows a
 *   restore was handed, with `spent` and `consumedBy` saying who spent it,
 *   which is what a service whose objects are retracted by a spend needs to
 *   rebuild that retraction after a restart. Its extra optional parameters
 *   are the engine's (`spent`, `includeBEEF`).
 * - `findOutputsForTransaction` reads every output of a transaction.
 * - `deleteOutput` and `deleteAppliedTransaction` drop what a module no
 *   longer keeps without telling the lookup services (for that, use
 *   `engine.evict`).
 */
export interface RestoreStorage {
  findOutput: (txid: string, outputIndex: number, topic?: string, spent?: boolean, includeBEEF?: boolean) => Promise<Output | null>
  findOutputsForTransaction?: (txid: string, includeBEEF?: boolean) => Promise<Output[]>
  deleteOutput?: (txid: string, outputIndex: number, topic: string) => Promise<void>
  deleteAppliedTransaction?: (txid: string, topic: string) => Promise<void>
}

/**
 * A lookup service that can rebuild its index from storage on start. The
 * engine does not replay past admissions into a lookup service, so a module
 * whose index lives in memory must offer one of these or come back empty
 * after every restart. Both are called before the port opens, with the
 * unspent outputs of the topics the SAME module declares, each with its
 * BEEF, in admission order, and the host's storage; each returns how many it
 * indexed.
 *
 * - `restore` is handed every output at once, as an array. The host reads
 *   them a page at a time and keeps each BEEF as bytes until it is read, but
 *   the array itself grows with the topics.
 * - `restoreFrom` is handed them one at a time, read a page at a time, so the
 *   host holds one page however large the topics are. A service that has
 *   both is called through `restoreFrom`.
 */
export interface RestorableLookupService extends LookupService {
  restore?: (outputs: Output[], storage: RestoreStorage) => number | Promise<number>
  restoreFrom?: (outputs: AsyncIterable<Output>, storage: RestoreStorage) => Promise<number>
}

export interface Module {
  topics?: Record<string, TopicManager>
  lookups?: Record<string, RestorableLookupService>
}

export type ModuleFactory = (host: ModuleHost) => Module | Promise<Module>

export interface LoadedModule {
  readonly path: string
  readonly module: Module
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Shape checks on what a factory returned, so a module that exports the
 * wrong thing fails here with its path in the message rather than inside the
 * engine with a stack trace that names neither the module nor the mistake.
 */
function checkModule(path: string, m: unknown): Module {
  if (!isRecord(m)) {
    throw new ConfigError(`module ${path}: create() did not return an object`)
  }
  const out: Module = {}
  if (m['topics'] !== undefined) {
    if (!isRecord(m['topics'])) throw new ConfigError(`module ${path}: topics is not an object`)
    for (const [name, tm] of Object.entries(m['topics'])) {
      if (name.trim() === '') throw new ConfigError(`module ${path}: a topic has an empty name`)
      if (!isRecord(tm) || typeof tm['identifyAdmissibleOutputs'] !== 'function') {
        throw new ConfigError(`module ${path}: topic ${name} is not a topic manager`)
      }
    }
    out.topics = m['topics'] as Record<string, TopicManager>
  }
  if (m['lookups'] !== undefined) {
    if (!isRecord(m['lookups'])) throw new ConfigError(`module ${path}: lookups is not an object`)
    for (const [name, ls] of Object.entries(m['lookups'])) {
      if (name.trim() === '') throw new ConfigError(`module ${path}: a lookup has an empty name`)
      if (
        !isRecord(ls) ||
        typeof ls['lookup'] !== 'function' ||
        typeof ls['outputAdmittedByTopic'] !== 'function' ||
        typeof ls['admissionMode'] !== 'string'
      ) {
        throw new ConfigError(`module ${path}: lookup ${name} is not a lookup service`)
      }
    }
    out.lookups = m['lookups'] as Record<string, RestorableLookupService>
  }
  if (Object.keys(out.topics ?? {}).length === 0 && Object.keys(out.lookups ?? {}).length === 0) {
    // A module that mounts nothing is a configuration mistake, not a quiet
    // success: the operator named it because they expected it to do
    // something.
    throw new ConfigError(`module ${path} mounts no topics and no lookups`)
  }
  return out
}

/**
 * Import each module and run its factory. Paths must be absolute: a relative
 * one would resolve against wherever the process happened to start, which is
 * not a property an operator can read off the unit file.
 */
export async function loadModules(
  paths: readonly string[],
  host: ModuleHost | ((path: string) => ModuleHost),
): Promise<LoadedModule[]> {
  const out: LoadedModule[] = []
  for (const path of paths) {
    if (!isAbsolute(path)) throw new ConfigError(`module path "${path}" is not absolute`)
    let imported: unknown
    try {
      imported = await import(pathToFileURL(path).href)
    } catch (err) {
      throw new ConfigError(`module ${path} could not be loaded: ${String((err as Error).message ?? err)}`)
    }
    const create = (imported as { default?: unknown }).default
    if (typeof create !== 'function') {
      throw new ConfigError(`module ${path}: default export is not a create(host) function`)
    }
    let created: unknown
    try {
      created = await (create as ModuleFactory)(typeof host === 'function' ? host(path) : host)
    } catch (err) {
      throw new ConfigError(`module ${path}: create(host) failed: ${String((err as Error).message ?? err)}`)
    }
    out.push({ path, module: checkModule(path, created) })
  }
  return out
}

/** What each module mounted, for the startup log. */
export interface Mounted {
  readonly path: string
  readonly topics: readonly string[]
  readonly lookups: readonly string[]
}

/**
 * Mount loaded modules into the engine's manager and lookup maps.
 *
 * `managers` arrives already holding the default manager for every configured
 * topic; a module's manager replaces it. `lookupServices` arrives holding the
 * host's own services; a module's lookups are added and a name collision is
 * refused, because the maps are plain objects and a duplicate would keep the
 * last value with no error at all.
 */
export function mountModules(
  loaded: readonly LoadedModule[],
  topics: readonly string[],
  managers: Record<string, TopicManager>,
  lookupServices: Record<string, LookupService>,
): Mounted[] {
  const out: Mounted[] = []
  const claimedBy = new Map<string, string>()
  for (const { path, module } of loaded) {
    const mountedTopics: string[] = []
    for (const [topic, tm] of Object.entries(module.topics ?? {})) {
      if (!topics.includes(topic)) {
        throw new ConfigError(`module ${path} mounts topic ${topic} which OVERLAY_TOPICS does not name`)
      }
      const other = claimedBy.get(topic)
      if (other !== undefined) {
        throw new ConfigError(`module ${path} mounts topic ${topic} which module ${other} already mounts`)
      }
      claimedBy.set(topic, path)
      managers[topic] = tm
      mountedTopics.push(topic)
    }
    const mountedLookups: string[] = []
    for (const [name, ls] of Object.entries(module.lookups ?? {})) {
      if (lookupServices[name] !== undefined) {
        throw new ConfigError(`module ${path} mounts lookup ${name} which is already mounted`)
      }
      lookupServices[name] = ls
      mountedLookups.push(name)
    }
    out.push({ path, topics: mountedTopics, lookups: mountedLookups })
  }
  return out
}

/** Where a module may mount a route: under a lookup service it mounts. */
const ROUTE = /^\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.~/-]+$/

/** The routes modules asked for, checked against what each mounted. */
export class ModuleRoutes {
  private readonly pending: Array<{ module: string; path: string; handler: RouteHandler }> = []
  private readonly routes = new Map<string, RouteHandler>()

  /** The `route` a module's host carries. */
  forModule(module: string): (path: string, handler: RouteHandler) => void {
    return (path, handler) => {
      if (typeof handler !== 'function') throw new ConfigError(`module ${module}: route ${path} has no handler`)
      this.pending.push({ module, path, handler })
    }
  }

  /**
   * Checks every requested route against the lookups its module mounted and
   * makes them servable. A route outside `/<own lookup>/...`, or one asked
   * twice, is a ConfigError.
   */
  mount(loaded: readonly LoadedModule[]): string[] {
    const lookupsOf = new Map(loaded.map((l) => [l.path, new Set(Object.keys(l.module.lookups ?? {}))]))
    for (const r of this.pending) {
      const m = ROUTE.exec(r.path)
      if (m === null || r.path.includes('//') || r.path.endsWith('/')) {
        throw new ConfigError(`module ${r.module}: route ${r.path} is not /<lookup>/<name>`)
      }
      if (lookupsOf.get(r.module)?.has(m[1] as string) !== true) {
        throw new ConfigError(`module ${r.module}: route ${r.path} is not under a lookup this module mounts`)
      }
      if (this.routes.has(r.path)) throw new ConfigError(`module ${r.module}: route ${r.path} is mounted twice`)
      this.routes.set(r.path, r.handler)
    }
    this.pending.length = 0
    return [...this.routes.keys()]
  }

  /** The handler for a request path: the longest mounted path it is, or is below. */
  find(path: string): RouteHandler | undefined {
    let best: string | undefined
    for (const p of this.routes.keys()) {
      if ((path === p || path.startsWith(p + '/')) && (best === undefined || p.length > best.length)) best = p
    }
    return best === undefined ? undefined : this.routes.get(best)
  }
}

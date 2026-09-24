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
 * `create(host)`. It is handed the host's logger and metrics and returns the
 * topic managers and lookup services it mounts. Its topic names must be ones
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
import type { TopicManager, LookupService, Output } from '@lightwebinc/overlay'
import { ConfigError } from './config.js'

/** What the host hands a module at load time. */
export interface ModuleHost {
  log: (msg: string, extra?: Record<string, unknown>) => void
  metrics: {
    inc: (name: string, labels?: Record<string, string>, by?: number) => void
    preset: (name: string, labels?: Record<string, string>) => void
    gauge: (name: string, fn: () => number) => void
  }
}

/**
 * A lookup service that can rebuild its index from storage on start. The
 * engine does not replay past admissions into a lookup service, so a module
 * whose index lives in memory must offer this or come back empty after every
 * restart. It is called with the unspent outputs of the topics the SAME module
 * declares, before the port opens, and returns how many it indexed.
 */
export interface RestorableLookupService extends LookupService {
  restore?: (outputs: Output[]) => number
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
export async function loadModules(paths: readonly string[], host: ModuleHost): Promise<LoadedModule[]> {
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
      created = await (create as ModuleFactory)(host)
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

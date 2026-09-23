import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
/**
 * The versions ACTUALLY INSTALLED under node_modules, resolved through
 * require(), not the ranges package.json asks for.
 *
 * The distinction is the whole point. A manifest states an intent; what is
 * loaded is a fact, and they diverge silently - a lockfile that was not
 * reinstalled, an image built before a bump, a volume mount carrying an older
 * tree. The sibling Go bridge publishes the same thing for the same reason,
 * after a version skew there cost a ninety-minute total object-plane outage
 * that no metric could see.
 *
 * A package that cannot be resolved reports "unknown" rather than throwing:
 * this runs at startup and a metrics label must never be the reason a host
 * refuses to boot.
 */
export function installedVersions(): Record<string, string> {
  const req = createRequire(import.meta.url)
  const read = (pkg: string): string => {
    try {
      // Resolve the package's ENTRY POINT, then walk up to the package.json
      // beside it. Asking for `${pkg}/package.json` directly is the obvious
      // way and it does not work: a package whose `exports` map does not list
      // "./package.json" makes that resolve throw, which is most modern
      // packages, and the catch then reports "unknown" for everything. That
      // shipped once and read as an answer.
      let dir = dirname(req.resolve(pkg))
      for (let i = 0; i < 8; i++) {
        const candidate = join(dir, 'package.json')
        if (existsSync(candidate)) {
          const j = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
          if (j.name === pkg && typeof j.version === 'string') return j.version
        }
        const up = dirname(dir)
        if (up === dir) break
        dir = up
      }
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return {
    overlay: read('@bsv/overlay'),
    sdk: read('@bsv/sdk'),
    gasp: read('@bsv/gasp'),
    node: process.versions.node,
  }
}

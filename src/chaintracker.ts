import type { ChainTracker } from '@bsv/sdk'

/**
 * A chain tracker backed by the bridge's header read API.
 *
 * This is what makes verification sovereign: every object this host admits is
 * checked against headers the host itself received off the header lane, from
 * the same network that delivered the object, with no third-party header
 * service in the loop and no rate limit to be subject to.
 *
 * It speaks the bridge's native `/v1` shape rather than the chaintracks one.
 * The chaintracks shape exists for a stock host that can only be pointed at a
 * header service by configuration; this host constructs its own tracker, so it
 * uses the contract meant for a consumer that can.
 */
export class BridgeChainTracker implements ChainTracker {
  constructor(
    private readonly base: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const url = `${this.base.replace(/\/+$/, '')}${path}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal })
      if (res.status !== 200) return { status: res.status, body: undefined }
      return { status: 200, body: await res.json() }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A height the store does not hold answers 404, which is reported as "not
   * valid" with no error: it means the proof cannot be checked yet, not that
   * something is broken. Any other non-ok status IS an error, because an
   * engine must not read a broken header service as a failed proof.
   */
  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const { status, body } = await this.get(`/v1/root/${height}`)
    if (status === 404) return false
    if (status !== 200) {
      throw new Error(`chain tracker: root for height ${height}: status ${status}`)
    }
    const merkleRoot = (body as { merkleRoot?: unknown }).merkleRoot
    if (typeof merkleRoot !== 'string') {
      throw new Error(`chain tracker: no merkleRoot in the answer for height ${height}`)
    }
    return merkleRoot === root
  }

  async currentHeight(): Promise<number> {
    const { status, body } = await this.get('/v1/tip')
    if (status !== 200) throw new Error(`chain tracker: tip: status ${status}`)
    const height = (body as { height?: unknown }).height
    if (typeof height !== 'number') throw new Error('chain tracker: no height in the tip answer')
    return height
  }
}

/** A tracker that can drop what it remembers about a height. */
export interface Forgetful {
  forget?: (height: number) => void
}

export interface CacheOptions {
  /** How long a tip answer is reused, in milliseconds. */
  readonly tipMs?: number
  /** How long a root found valid is reused, in milliseconds. */
  readonly rootMs?: number
  /** Roots kept at most. */
  readonly maxRoots?: number
}

/**
 * The engine's view of a header source, with the two questions it asks on
 * every admission answered from memory for a moment.
 *
 * The engine asks for the tip once per admitted topic (to stamp when it first
 * saw a transaction) and for a root once per proven transaction in a BEEF,
 * and against a bridge each of those was an HTTP round trip on the engine's
 * only thread: a lab host made one tip and one root request per object it
 * admitted. A tip reused for a second and a VALID root reused for half a
 * minute answer the same questions with the same values, except across a
 * block that leaves the best chain inside that half minute; the reorg watch
 * asks `fresh`, which never reads the cache, and puts that right.
 *
 * Only a root that verified is kept. A root the source did not know may be
 * known a moment later, and a refusal must not outlive that.
 */
export class CachedChainTracker implements ChainTracker {
  private tip: { height: number; at: number } | undefined
  private tipInFlight: Promise<number> | undefined
  private readonly roots = new Map<number, { root: string; at: number }>()
  private readonly tipMs: number
  private readonly rootMs: number
  private readonly maxRoots: number

  /** The same source, every answer asked of it; it also corrects the cache. */
  readonly fresh: ChainTracker

  constructor(
    private readonly inner: ChainTracker & Forgetful,
    opts: CacheOptions = {},
  ) {
    this.tipMs = opts.tipMs ?? 1_000
    this.rootMs = opts.rootMs ?? 30_000
    this.maxRoots = opts.maxRoots ?? 10_000
    this.fresh = {
      isValidRootForHeight: async (root, height) => {
        this.inner.forget?.(height)
        const ok = await this.inner.isValidRootForHeight(root, height)
        const hit = this.roots.get(height)
        if (ok) this.remember(height, root)
        else if (hit !== undefined && hit.root === root.toLowerCase()) this.roots.delete(height)
        return ok
      },
      currentHeight: async () => {
        const h = await this.inner.currentHeight()
        this.tip = { height: h, at: Date.now() }
        return h
      },
    }
  }

  private remember(height: number, root: string): void {
    if (this.roots.size >= this.maxRoots) this.roots.clear()
    this.roots.set(height, { root: root.toLowerCase(), at: Date.now() })
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const hit = this.roots.get(height)
    if (hit !== undefined && Date.now() - hit.at < this.rootMs && hit.root === root.toLowerCase()) return true
    const ok = await this.inner.isValidRootForHeight(root, height)
    if (ok) this.remember(height, root)
    return ok
  }

  async currentHeight(): Promise<number> {
    const t = this.tip
    if (t !== undefined && Date.now() - t.at < this.tipMs) return t.height
    // Callers that arrive while a request is out share it.
    this.tipInFlight ??= this.inner
      .currentHeight()
      .then((h) => {
        this.tip = { height: h, at: Date.now() }
        return h
      })
      .finally(() => {
        this.tipInFlight = undefined
      })
    return await this.tipInFlight
  }
}

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

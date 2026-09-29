import { Hash, type ChainTracker } from '@bsv/sdk'
import { BridgeChainTracker } from './chaintracker.js'

/**
 * Header sources other than a bridge: the public WhatsOnChain API and any
 * chaintracks v2 service. Neither is taken at its word. Every header one of
 * them answers is hashed here and must carry the work its bits claim, and on
 * mainnet must claim at least MAINNET_MIN_DIFFICULTY, so a source that lies
 * about a root has to mine a block to do it. The Go reader in
 * github.com/lightwebinc/bcommon/headers makes the same check with the same
 * floor.
 */

export type Network = 'main' | 'test' | 'regtest'

/**
 * Every mainnet block since the 2018 split has carried a difficulty between
 * about 2.6e10 and 5.2e11. The floor sits well under the lowest and well above
 * what a lie can be mined for (about 1.7e19 hashes per header).
 */
export const MAINNET_MIN_DIFFICULTY = 4_000_000_000n

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/'

export class HeaderSourceError extends Error {}

/** A header whose fields do not carry the work they claim. */
export class ProofOfWorkError extends Error {}

export interface ParsedSource {
  kind: 'native' | 'whatsonchain' | 'chaintracks'
  base: string
  network: Network | undefined
}

function httpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== ''
  } catch {
    return false
  }
}

/**
 * `woc:main` | `woc:test` | `chaintracks:https://host/v2` | a bridge URL.
 */
export function parseSource(spec: string): ParsedSource {
  const s = spec.trim()
  if (s.startsWith('woc:')) {
    const net = s.slice(4)
    if (net !== 'main' && net !== 'test') {
      throw new HeaderSourceError(`header source ${spec}: WhatsOnChain serves woc:main or woc:test`)
    }
    return { kind: 'whatsonchain', base: WOC_BASE + net, network: net }
  }
  if (s.startsWith('chaintracks:')) {
    const base = s.slice('chaintracks:'.length).replace(/\/+$/, '')
    if (!httpUrl(base)) throw new HeaderSourceError(`header source ${spec}: not an http or https URL`)
    return { kind: 'chaintracks', base, network: 'main' }
  }
  if (!httpUrl(s)) {
    throw new HeaderSourceError(`header source ${spec}: use woc:main, chaintracks:URL or a bridge URL`)
  }
  return { kind: 'native', base: s.replace(/\/+$/, ''), network: undefined }
}

function compactToTarget(bits: number): bigint {
  const mantissa = BigInt(bits & 0x007fffff)
  const exp = bits >>> 24
  const t = exp <= 3 ? mantissa >> BigInt(8 * (3 - exp)) : mantissa << BigInt(8 * (exp - 3))
  return (bits & 0x00800000) !== 0 ? -t : t
}

const MAX_TARGET = compactToTarget(0x1d00ffff)

function hexToInternal(hex: string, what: string, height: number): number[] {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new HeaderSourceError(`header service: height ${height}: ${what} is not a 32-byte hash`)
  }
  const out: number[] = []
  for (let i = 62; i >= 0; i -= 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

export interface WireHeader {
  height: number
  version: number
  hash: string
  merkleRoot?: string
  merkleroot?: string
  previousHash?: string
  previousblockhash?: string
  time: number
  bits: number | string
  nonce: number
}

/**
 * Proves a header is what the source says it is and returns its merkle root
 * in display hex. Throws ProofOfWorkError otherwise.
 */
export function checkHeader(w: WireHeader, want: number, minDifficulty: bigint): string {
  if (w.height !== want) {
    throw new ProofOfWorkError(`asked for height ${want}, answered for ${w.height}`)
  }
  const root = w.merkleRoot ?? w.merkleroot ?? ''
  const prev = w.previousHash ?? w.previousblockhash ?? (want === 0 ? '0'.repeat(64) : '')
  const bits = typeof w.bits === 'string' ? parseInt(w.bits, 16) : w.bits
  const bytes = [
    ...u32le(w.version),
    ...hexToInternal(prev, 'previous hash', want),
    ...hexToInternal(root, 'merkle root', want),
    ...u32le(w.time),
    ...u32le(bits),
    ...u32le(w.nonce),
  ]
  const digest = Hash.hash256(bytes)
  const display = [...digest].reverse().map((b) => b.toString(16).padStart(2, '0')).join('')
  if (display !== w.hash.toLowerCase()) {
    throw new ProofOfWorkError(`height ${want}: the fields hash to ${display}, not the claimed ${w.hash}`)
  }
  const target = compactToTarget(bits)
  if (target <= 0n) throw new ProofOfWorkError(`height ${want}: bits ${bits.toString(16)} is not a target`)
  if (BigInt('0x' + display) > target) {
    throw new ProofOfWorkError(`height ${want}: hash is above its own target`)
  }
  if (minDifficulty > 0n && target > MAX_TARGET / minDifficulty) {
    throw new ProofOfWorkError(`height ${want}: bits ${bits.toString(16)} claim less work than the network floor`)
  }
  return root.toLowerCase()
}

/**
 * A chain tracker over WhatsOnChain or chaintracks. A 404 is "not known",
 * reported as not valid with no error, as the bridge tracker does; any other
 * failure, and every failed proof of work, throws.
 */
export class HeaderSourceChainTracker implements ChainTracker {
  constructor(
    private readonly src: ParsedSource,
    private readonly network: Network | undefined,
    private readonly timeoutMs = 10_000,
  ) {}

  private minDifficulty(): bigint {
    return this.network === 'main' ? MAINNET_MIN_DIFFICULTY : 0n
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.src.base + path, { headers: { Accept: 'application/json' }, signal: ac.signal })
      if (res.status !== 200) return { status: res.status, body: undefined }
      return { status: 200, body: await res.json() }
    } finally {
      clearTimeout(timer)
    }
  }

  private async header(height: number): Promise<WireHeader | undefined> {
    const path = this.src.kind === 'whatsonchain' ? `/block/${height}/header` : `/header/height/${height}`
    const { status, body } = await this.get(path)
    if (status === 404) return undefined
    if (status !== 200) throw new Error(`chain tracker: header at height ${height}: status ${status}`)
    if (this.src.kind === 'whatsonchain') return body as WireHeader
    const env = body as { status?: string; value?: WireHeader }
    if (env.status !== 'success' || env.value == null) {
      throw new Error(`chain tracker: header at height ${height}: status ${String(env.status)} with no header`)
    }
    return env.value
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const h = await this.header(height)
    if (h === undefined) return false
    // The work is checked before the root is compared, so a forged header
    // throws even when its root is the one the caller hoped for.
    return checkHeader(h, height, this.minDifficulty()) === root.toLowerCase()
  }

  async currentHeight(): Promise<number> {
    const path = this.src.kind === 'whatsonchain' ? '/chain/info' : '/height'
    const { status, body } = await this.get(path)
    if (status !== 200) throw new Error(`chain tracker: tip: status ${status}`)
    const height =
      this.src.kind === 'whatsonchain'
        ? (body as { blocks?: unknown }).blocks
        : (body as { value?: { height?: unknown } }).value?.height
    if (typeof height !== 'number') throw new Error('chain tracker: no height in the tip answer')
    return height
  }
}

/**
 * The tracker for a header source specification. `network` overrides the one
 * the specification implies (it decides the proof-of-work floor).
 */
export function chainTrackerFor(spec: string, network?: Network): ChainTracker {
  const src = parseSource(spec)
  if (src.kind === 'native') return new BridgeChainTracker(src.base)
  return new HeaderSourceChainTracker(src, network ?? src.network)
}

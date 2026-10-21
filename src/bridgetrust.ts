/**
 * The bridge's SPV trust marker: when to believe that the overlay bridge on
 * this machine has already verified an object's scripts.
 *
 * The bridge (overlay-bridge `-verify enforce`) verifies every delivered
 * object by SPV with the Go SDK before submitting it, and marks one that
 * passed with the header `X-Overlay-Bridge-Verified: v1=<hex>`: an
 * HMAC-SHA256, under a key the two share through a root-only file, over a
 * fixed label and the exact body. This host honours the marker only when ALL
 * of these hold:
 *
 *  1. OVERLAY_TRUST_BRIDGE_VERIFY is true (default false);
 *  2. the request arrived on a loopback address;
 *  3. the host holds the key, and the HMAC over the body it actually read
 *     matches, compared in constant time.
 *
 * Loopback alone is not enough (anything on the machine reaches loopback);
 * the key alone is not enough (a leaked key must not let a remote submitter
 * skip verification). The HMAC binds the marker to one body, so a marker seen
 * on the wire cannot be moved to another object.
 *
 * A marker that fails any check is IGNORED, not refused: the object is then
 * verified in full, as if it carried no marker.
 *
 * What an honoured marker waives is SCRIPT verification only, through the
 * pool's backend (src/verifypool.ts). The engine still parses the object,
 * checks every merkle path against this host's chain tracker, checks amounts,
 * and runs its topic managers.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export const MARKER_HEADER = 'x-overlay-bridge-verified'
const LABEL = Buffer.from('overlay-bridge-verified/v1\x00', 'latin1')
export const MIN_KEY_BYTES = 32

/** How one marker was judged. These are metric label values. */
export type MarkerResult = 'accepted' | 'disabled' | 'not_loopback' | 'bad_mac'
export const MarkerResults: readonly MarkerResult[] = ['accepted', 'disabled', 'not_loopback', 'bad_mac']

/** The marker for body under key, as the bridge computes it. */
export function marker(key: Buffer, body: Buffer): string {
  return 'v1=' + createHmac('sha256', key).update(LABEL).update(body).digest('hex')
}

/** Reads a marker key file: its bytes, whitespace trimmed. Refuses a short or group/world-readable one. */
export function loadKey(path: string): Buffer {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(`bridge marker key ${path} is readable by group or others (mode ${mode.toString(8)}); chmod 600 it`)
  }
  const key = Buffer.from(readFileSync(path, 'latin1').trim(), 'latin1')
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`bridge marker key ${path} is ${key.length} bytes; at least ${MIN_KEY_BYTES} are required`)
  }
  return key
}

/** True for an IPv4 or IPv6 loopback peer, including the v4-mapped form. */
export function isLoopback(addr: string | undefined): boolean {
  if (addr === undefined) return false
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

export class BridgeTrust {
  /** key undefined = trust disabled. */
  constructor(private readonly key: Buffer | undefined) {}

  get enabled(): boolean {
    return this.key !== undefined
  }

  /** Judge one marker. Call only when the header is present. */
  check(remote: string | undefined, value: string, body: Buffer): MarkerResult {
    if (this.key === undefined) return 'disabled'
    if (!isLoopback(remote)) return 'not_loopback'
    const want = Buffer.from(marker(this.key, body), 'latin1')
    const got = Buffer.from(value.trim(), 'latin1')
    if (got.length !== want.length || !timingSafeEqual(got, want)) return 'bad_mac'
    return 'accepted'
  }
}

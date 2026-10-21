/**
 * The marker end to end through POST /submit: a stand-in engine that does
 * exactly what the engine does with an object (Transaction.fromBEEF, then
 * verify against the chain tracker) behind the real server and the real pool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MerklePath, P2PKH, PrivateKey, Transaction, type ChainTracker } from '@bsv/sdk'
import type { Engine } from '@lightwebinc/overlay'
import { buildServer } from './http.js'
import { Metrics } from './metrics.js'
import { VerifyPool } from './verifypool.js'
import { BridgeTrust, MARKER_HEADER, marker } from './bridgetrust.js'

const key = Buffer.from('0123456789abcdef0123456789abcdef', 'latin1')

async function badScriptBEEF(): Promise<{ beef: Buffer; tracker: ChainTracker }> {
  const owner = PrivateKey.fromRandom()
  const parent = new Transaction()
  parent.addOutput({ lockingScript: new P2PKH().lock(owner.toAddress()), satoshis: 1000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 1000)
  const child = new Transaction()
  // Signed by the wrong key: only a skipped script check lets it through.
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(PrivateKey.fromRandom()) })
  child.addOutput({ lockingScript: new P2PKH().lock(owner.toAddress()), satoshis: 900 })
  await child.sign()
  const tracker: ChainTracker = {
    isValidRootForHeight: async (root, h) => h === 1000 && root === parent.merklePath?.computeRoot(parent.id('hex')),
    currentHeight: async () => 1200,
  }
  return { beef: Buffer.from(child.toBEEF()), tracker }
}

test('POST /submit honours a loopback marker and ignores a bad one', async () => {
  const { beef, tracker } = await badScriptBEEF()
  const engine = {
    submit: async (t: { beef: number[] }) => {
      if (!(await Transaction.fromBEEF(t.beef).verify(tracker))) throw new Error('verify false')
      return { tm_x: { outputsToAdmit: [0], coinsToRetain: [] } }
    },
  } as unknown as Engine
  const pool = new VerifyPool(0)
  pool.install()
  const metrics = new Metrics()
  const server = buildServer({
    engine, metrics, adminToken: 'x', topics: ['tm_x'], syncPeers: {}, ready: () => true, log: () => {},
    bridgeTrust: new BridgeTrust(key),
    trustTxids: (ids) => pool.trust(ids),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/submit`
  const post = async (mark?: string): Promise<number> => {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-topics': 'tm_x' }
    if (mark !== undefined) headers[MARKER_HEADER] = mark
    return (await fetch(url, { method: 'POST', headers, body: new Uint8Array(beef) })).status
  }
  try {
    assert.equal(await post(), 400, 'no marker: verified, and the scripts fail')
    assert.equal(await post(marker(Buffer.alloc(32, 9), beef)), 400, 'a marker under another key is ignored')
    assert.equal(await post(marker(key, beef)), 200, 'a valid loopback marker skips the scripts')
    assert.equal(await post(), 400, 'trust ends with the submission')
  } finally {
    server.close()
    await pool.close()
  }
  assert.equal(pool.skipped, 1)
  const out = metrics.render()
  assert.match(out, /overlay_host_bridge_marker_total\{result="accepted"\} 1/)
  assert.match(out, /overlay_host_bridge_marker_total\{result="bad_mac"\} 1/)
  assert.match(out, /overlay_host_bridge_marker_total\{result="not_loopback"\} 0/)
})

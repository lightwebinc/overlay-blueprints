import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MerklePath, P2PKH, PrivateKey, Transaction, type ChainTracker } from '@bsv/sdk'
import { VerifyPool } from './verifypool.js'

/** A child of a mined parent, signed by `signer`; the parent pays `owner`. */
async function spend(owner: PrivateKey, signer: PrivateKey, inputs = 1) {
  const parent = new Transaction()
  for (let i = 0; i < inputs; i++) parent.addOutput({ lockingScript: new P2PKH().lock(owner.toAddress()), satoshis: 1000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 1000)
  const child = new Transaction()
  for (let i = 0; i < inputs; i++) {
    child.addInput({ sourceTransaction: parent, sourceOutputIndex: i, unlockingScriptTemplate: new P2PKH().unlock(signer) })
  }
  child.addOutput({ lockingScript: new P2PKH().lock(owner.toAddress()), satoshis: 900 })
  await child.sign()
  const tracker: ChainTracker = {
    isValidRootForHeight: async (root, h) => h === 1000 && root === parent.merklePath?.computeRoot(parent.id('hex')),
    currentHeight: async () => 1200,
  }
  return { beef: child.toBEEF(), tracker }
}

/** The verdict of Transaction.verify, false for a throw as the engine reads both. */
async function verdict(beef: number[], tracker: ChainTracker): Promise<boolean> {
  try {
    return await Transaction.fromBEEF(beef).verify(tracker)
  } catch {
    return false
  }
}

test('verification through the worker pool reaches the inline verdict', async () => {
  const k = PrivateKey.fromRandom()
  const cases = [
    { name: 'valid, one input', ...(await spend(k, k)), want: true },
    { name: 'valid, three inputs', ...(await spend(k, k, 3)), want: true },
    { name: 'signed by the wrong key', ...(await spend(k, PrivateKey.fromRandom())), want: false },
  ]
  const inline = await Promise.all(cases.map(async (c) => await verdict(c.beef, c.tracker)))
  assert.deepEqual(inline, cases.map((c) => c.want), 'the inline interpreter, as a control')

  const pool = new VerifyPool(2)
  pool.install()
  try {
    const pooled = await Promise.all(cases.map(async (c) => await verdict(c.beef, c.tracker)))
    assert.deepEqual(pooled, inline)
    assert.equal(pool.verified, 3, 'every script check went to a worker')
    assert.equal(pool.refused, 1)
    assert.equal(pool.inFlight, 0)
  } finally {
    await pool.close()
  }
  // Closed, the backend is gone and verification is inline again.
  assert.deepEqual(await Promise.all(cases.map(async (c) => await verdict(c.beef, c.tracker))), inline)
})

test('every verification is timed, worker and inline, by result', async () => {
  const k = PrivateKey.fromRandom()
  const good = await spend(k, k)
  const bad = await spend(k, PrivateKey.fromRandom())
  for (const size of [2, 0]) {
    const pool = new VerifyPool(size)
    const seen: Array<[number, string, string]> = []
    pool.onVerified = (s, r, p) => seen.push([s, r, p])
    pool.install()
    try {
      assert.equal(await verdict(good.beef, good.tracker), true)
      assert.equal(await verdict(bad.beef, bad.tracker), false)
    } finally {
      await pool.close()
    }
    const path = size > 0 ? 'worker' : 'inline'
    assert.deepEqual(seen.map(([, r, p]) => [r, p]), [['ok', path], ['refused', path]])
    for (const [s] of seen) assert.ok(s > 0 && s < 5, `a plausible duration: ${s}`)
    assert.equal(pool.verified, 2)
    assert.equal(pool.refused, 1)
  }
})

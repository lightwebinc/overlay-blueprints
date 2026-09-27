import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MerklePath, PrivateKey, P2PKH, Transaction, type ChainTracker } from '@bsv/sdk'
import { ingestProof } from './proofs.js'

/**
 * A mined parent and a child that spends it, the child proven by a
 * one-transaction block whose root is the child's own txid. The tracker knows
 * that root at `height` and nothing else, so it stands in for a host's own
 * header lane.
 */
async function fixture(height = 800_000) {
  const key = PrivateKey.fromRandom()
  const lock = new P2PKH().lock(key.toAddress())
  const parent = new Transaction()
  parent.addOutput({ lockingScript: lock, satoshis: 1000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), height - 1)
  const child = new Transaction()
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  child.addOutput({ lockingScript: lock, satoshis: 900 })
  await child.sign()
  const unproven = child.toAtomicBEEF()
  const path = MerklePath.fromCoinbaseTxidAndHeight(child.id('hex'), height)
  const proven = Transaction.fromAtomicBEEF(unproven)
  proven.merklePath = path
  const roots = new Map<number, string>([
    [height - 1, parent.merklePath.computeRoot(parent.id('hex'))],
    [height, path.computeRoot(child.id('hex'))],
  ])
  // A one-transaction block puts the child at index 0, which the SDK reads as
  // a coinbase and holds to 100 confirmations. A real transaction is never at
  // index 0, so the tip is set deep enough that this fixture's shape does not
  // stand in for a maturity rule the code never meets.
  const tracker: ChainTracker = {
    isValidRootForHeight: async (root, h) => roots.get(h) === root,
    currentHeight: async () => height + 200,
  }
  return { child, unproven, proven: proven.toAtomicBEEF(), tracker, txid: child.id('hex') }
}

/** An engine stub: storage holds the child as `stored`, and records every proof it is asked to ingest. */
function engine(tracker: ChainTracker | 'scripts only', stored: number[] | undefined, txid: string) {
  const ingested: string[] = []
  return {
    ingested,
    chainTracker: tracker,
    storage: {
      findOutputsForTransaction: async (id: string) =>
        stored !== undefined && id === txid ? [{ txid, outputIndex: 0, beef: stored }] : [],
    },
    handleNewMerkleProof: async (id: string) => {
      ingested.push(id)
    },
  } as unknown as Parameters<typeof ingestProof>[0] & { ingested: string[] }
}

test('a proof for a transaction held unproven is verified and ingested', async () => {
  const f = await fixture()
  const e = engine(f.tracker, f.unproven, f.txid)
  assert.equal(await ingestProof(e, f.proven), 'upgraded')
  assert.deepEqual(e.ingested, [f.txid])
})

test('a transaction already held proven is not rewritten', async () => {
  const f = await fixture()
  const e = engine(f.tracker, f.proven, f.txid)
  assert.equal(await ingestProof(e, f.proven), 'already')
  assert.deepEqual(e.ingested, [])
})

// The one that matters: anyone may submit, so a path that does not name a
// block THIS host knows is refused before anything is written.
test('a path that does not verify against this host\'s own headers is refused', async () => {
  const f = await fixture()
  const stranger: ChainTracker = { isValidRootForHeight: async () => false, currentHeight: async () => 900_000 }
  const e = engine(stranger, f.unproven, f.txid)
  assert.equal(await ingestProof(e, f.proven), 'unverified')
  assert.deepEqual(e.ingested, [])
})

test('a host with no headers ingests nothing', async () => {
  const f = await fixture()
  const e = engine('scripts only', f.unproven, f.txid)
  assert.equal(await ingestProof(e, f.proven), 'unverified')
  assert.deepEqual(e.ingested, [])
})

test('no proof, and a transaction this host does not hold, are both no-ops', async () => {
  const f = await fixture()
  assert.equal(await ingestProof(engine(f.tracker, f.unproven, f.txid), f.unproven), 'no-proof')
  const e = engine(f.tracker, undefined, f.txid)
  assert.equal(await ingestProof(e, f.proven), 'unknown')
  assert.deepEqual(e.ingested, [])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hash } from '@bsv/sdk'
import {
  checkHeader,
  chainTrackerFor,
  HeaderSourceChainTracker,
  HeaderSourceError,
  parseSource,
  ProofOfWorkError,
  MAINNET_MIN_DIFFICULTY,
  type WireHeader,
} from './headersource.js'
import { BridgeChainTracker } from './chaintracker.js'

/** Answers captured verbatim from the public services (shared with bcommon). */
function fixture(name: string): string {
  return readFileSync(new URL(`../test/fixtures/headers/${name}.json`, import.meta.url), 'utf8')
}

const ROOT_900000 = '62272ce3662923219acd98587fdb5c0b01557597036d8635207bda8a3fa72a7e'

async function serve(path: string, status: number, body: string): Promise<{ url: string; close: () => void }> {
  const srv: Server = createServer((req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() }
}

test('parseSource reads each form and refuses the rest', () => {
  assert.deepEqual(parseSource('woc:main'), {
    kind: 'whatsonchain',
    base: 'https://api.whatsonchain.com/v1/bsv/main',
    network: 'main',
  })
  assert.equal(parseSource('chaintracks:https://ct.example.com/v2/').base, 'https://ct.example.com/v2')
  assert.equal(parseSource('http://bridge.example.com:9178/').kind, 'native')
  for (const bad of ['', 'woc:regtest', 'chaintracks:', 'bridge.example.com', 'file:///etc']) {
    assert.throws(() => parseSource(bad), HeaderSourceError, bad)
  }
  assert.ok(chainTrackerFor('http://bridge.example.com:9178') instanceof BridgeChainTracker)
  assert.ok(chainTrackerFor('woc:main') instanceof HeaderSourceChainTracker)
})

test('real mainnet headers validate from both dialects', async () => {
  const woc = await serve('/block/900000/header', 200, fixture('woc-main-900000'))
  const ct = await serve('/header/height/900000', 200, fixture('chaintracks-900000'))
  try {
    for (const [kind, url] of [
      ['whatsonchain', woc.url],
      ['chaintracks', ct.url],
    ] as const) {
      const t = new HeaderSourceChainTracker({ kind, base: url, network: 'main' }, 'main')
      assert.equal(await t.isValidRootForHeight(ROOT_900000, 900000), true, kind)
      assert.equal(await t.isValidRootForHeight('11'.repeat(32), 900000), false, kind)
    }
  } finally {
    woc.close()
    ct.close()
  }
})

test('a forged root, nonce or height throws rather than matching', () => {
  const real = JSON.parse(fixture('woc-main-900000')) as WireHeader & Record<string, unknown>
  for (const [field, value] of [
    ['merkleroot', 'ab'.repeat(32)],
    ['nonce', 1],
    ['height', 900001],
  ] as const) {
    assert.throws(() => checkHeader({ ...real, [field]: value }, 900000, MAINNET_MIN_DIFFICULTY), ProofOfWorkError, field)
  }
})

test('a cheaply mined header fails the mainnet floor and passes regtest', () => {
  const root = 'cd'.repeat(32)
  const h: WireHeader = { height: 5, version: 0x20000000, hash: '', merkleroot: root, previousblockhash: '00'.repeat(32), time: 1790000000, bits: '207fffff', nonce: 0 }
  const le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
  const rev = (hex: string) => (hex.match(/../g) ?? []).map((b) => parseInt(b, 16)).reverse()
  for (;; h.nonce++) {
    const d = Hash.hash256([...le(h.version), ...rev(h.previousblockhash!), ...rev(root), ...le(h.time), ...le(0x207fffff), ...le(h.nonce)])
    const display = [...d].reverse().map((b) => b.toString(16).padStart(2, '0')).join('')
    if (BigInt('0x' + display) <= 0x7fffffn << 232n) {
      h.hash = display
      break
    }
  }
  assert.throws(() => checkHeader(h, 5, MAINNET_MIN_DIFFICULTY), ProofOfWorkError)
  assert.equal(checkHeader(h, 5, 0n), root)
})

test('testnet block 1 validates on test and fails the mainnet floor', () => {
  const h = JSON.parse(fixture('woc-test-1')) as WireHeader
  assert.equal(checkHeader(h, 1, 0n), h.merkleroot)
  assert.throws(() => checkHeader(h, 1, MAINNET_MIN_DIFFICULTY), ProofOfWorkError)
})

test('unknown height is false; a broken source throws', async () => {
  const nf = await serve('/nothing', 200, '{}')
  const broken = await serve('/header/height/900000', 500, '{"status":"error"}')
  const odd = await serve('/header/height/900000', 200, '{"status":"error"}')
  try {
    const t = (url: string) => new HeaderSourceChainTracker({ kind: 'chaintracks', base: url, network: 'main' }, 'main')
    assert.equal(await t(nf.url).isValidRootForHeight(ROOT_900000, 900000), false)
    await assert.rejects(t(broken.url).isValidRootForHeight(ROOT_900000, 900000))
    await assert.rejects(t(odd.url).isValidRootForHeight(ROOT_900000, 900000))
  } finally {
    nf.close()
    broken.close()
    odd.close()
  }
})

test('currentHeight per dialect', async () => {
  const woc = await serve('/chain/info', 200, '{"blocks":968932}')
  const ct = await serve('/height', 200, '{"status":"success","value":{"height":968932}}')
  try {
    assert.equal(await new HeaderSourceChainTracker({ kind: 'whatsonchain', base: woc.url, network: 'main' }, 'main').currentHeight(), 968932)
    assert.equal(await new HeaderSourceChainTracker({ kind: 'chaintracks', base: ct.url, network: 'main' }, 'main').currentHeight(), 968932)
  } finally {
    woc.close()
    ct.close()
  }
})

test('a 429 is retried, and a proven root is reused rather than asked again', async () => {
  let calls = 0
  const body = fixture('woc-main-900000')
  const srv: Server = createServer((req, res) => {
    calls++
    if (calls === 1) {
      res.writeHead(429, { 'retry-after': '0' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  try {
    const t = new HeaderSourceChainTracker({ kind: 'whatsonchain', base: `http://127.0.0.1:${port}`, network: 'main' }, 'main')
    assert.equal(await t.isValidRootForHeight(ROOT_900000, 900000), true)
    assert.equal(calls, 2)
    assert.equal(await t.isValidRootForHeight('11'.repeat(32), 900000), false)
    assert.equal(calls, 2)
  } finally {
    srv.close()
  }
})

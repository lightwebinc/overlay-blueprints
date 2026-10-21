import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeTrust, isLoopback, loadKey, marker } from './bridgetrust.js'

const key = Buffer.from('0123456789abcdef0123456789abcdef', 'latin1')
const body = Buffer.from('object', 'latin1')

test('the marker matches the bridge (pkg/spv TestMarkerVector)', () => {
  assert.equal(marker(key, body), 'v1=0d823c5f823e5058f96797f2c871875a949ecddf076b007a357fa120dd3ef038')
})

test('a marker is honoured only from loopback, with the key, over the same body', () => {
  const t = new BridgeTrust(key)
  const m = marker(key, body)
  assert.equal(t.check('127.0.0.1', m, body), 'accepted')
  assert.equal(t.check('::1', m, body), 'accepted')
  assert.equal(t.check('::ffff:127.0.0.1', m, body), 'accepted')
  assert.equal(t.check('10.0.0.2', m, body), 'not_loopback', 'a valid marker from off the machine')
  assert.equal(t.check('::ffff:10.0.0.2', m, body), 'not_loopback')
  assert.equal(t.check(undefined, m, body), 'not_loopback')
  assert.equal(t.check('127.0.0.1', m, Buffer.from('other object')), 'bad_mac', 'moved to another body')
  assert.equal(t.check('127.0.0.1', marker(Buffer.alloc(32, 7), body), body), 'bad_mac', 'another key')
  assert.equal(t.check('127.0.0.1', 'v1=', body), 'bad_mac')
  assert.equal(t.check('127.0.0.1', '', body), 'bad_mac')
  assert.equal(new BridgeTrust(undefined).check('127.0.0.1', m, body), 'disabled', 'trust is off by default')
})

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(a), a)
  for (const a of ['0.0.0.0', '::', '10.0.0.1', '::ffff:10.0.0.1', '1127.0.0.1', '127.0.0.1.evil', 'fe80::1']) {
    assert.ok(!isLoopback(a), a)
  }
})

test('the key file must be private and long enough', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-'))
  const p = join(dir, 'k')
  writeFileSync(p, '0123456789abcdef0123456789abcdef0123\n', { mode: 0o600 })
  assert.equal(loadKey(p).length, 36)
  chmodSync(p, 0o644)
  assert.throws(() => loadKey(p), /readable by group or others/)
  const s = join(dir, 's')
  writeFileSync(s, 'short', { mode: 0o600 })
  assert.throws(() => loadKey(s), /at least 32/)
})

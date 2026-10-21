#!/usr/bin/env node
/**
 * The host as a lab host runs it, on one machine: every bstack module mounted
 * together beside the parity topics, a load of real signed objects, the
 * parity walk, a proof upgrade, a reorganisation and the new proof that
 * follows it, a restart, and the walk again. Every check reads the running
 * host (its answers and its /metrics), never its log alone.
 *
 *   node scripts/lab.mjs [--objects N] [--modules <dir>]
 *
 * `--modules` is a directory holding each module's bundle as its repository
 * builds it: <dir>/bfinger/host/bundle/index.js, <dir>/bbox/host/bundle/
 * bbox-module.js, and so on (a directory of checkouts works). Absent ones are
 * skipped and named. The bundles are staged beside a link to this host's
 * node_modules, as a deployment places them, so they load the host's SDK.
 *
 * It needs Docker (a throwaway MySQL) and a built host (`npm run build`).
 * It serves block headers itself in the bridge's native shape. Everything it
 * starts, it stops.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, symlinkSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hash, MerklePath, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const OBJECTS = Number(arg('--objects', '400'))
const MODULES = arg('--modules', undefined)

let failures = 0
const ok = (what) => console.log(`ok    ${what}`)
const bad = (what) => {
  failures++
  console.log(`FAIL  ${what}`)
}
const expect = (what, cond) => (cond ? ok(what) : bad(what))

// ---- headers: the bridge's native shape, with roots this run can change.
const roots = new Map()
let tip = 900_000
const headers = createServer((req, res) => {
  const m = /^\/v1\/root\/(\d+)$/.exec(req.url ?? '')
  if (req.url === '/v1/tip') return res.end(JSON.stringify({ height: tip }))
  if (m !== null && roots.has(Number(m[1]))) return res.end(JSON.stringify({ merkleRoot: roots.get(Number(m[1])) }))
  res.statusCode = 404
  res.end()
})
await new Promise((r) => headers.listen(0, '127.0.0.1', r))
const headerURL = `http://127.0.0.1:${headers.address().port}`

// ---- a two-leaf block per height, so no transaction sits at index 0.
const rand = () => Utils.toHex(Hash.sha256(Utils.toArray(String(Math.random()))))
function mine(tx, height) {
  const txid = tx.id('hex')
  tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: rand() }, { offset: 1, hash: txid, txid: true }]])
  roots.set(height, tx.merklePath.computeRoot(txid))
}
const key = PrivateKey.fromRandom()
const lock = new P2PKH().lock(key.toAddress())
let height = 800_000
async function child(outputs = 2) {
  const parent = new Transaction()
  parent.addInput({ sourceTXID: rand(), sourceOutputIndex: 0, unlockingScript: lock, sequence: 0xffffffff })
  parent.addOutput({ lockingScript: lock, satoshis: 10_000 })
  mine(parent, ++height)
  const c = new Transaction()
  c.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  for (let i = 0; i < outputs; i++) c.addOutput({ lockingScript: lock, satoshis: 100 + i })
  await c.sign()
  return c
}

// ---- MySQL
const password = 'overlay-lab'
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const db = docker('run', '-d', '--rm', '-e', `MYSQL_ROOT_PASSWORD=${password}`, '-e', 'MYSQL_DATABASE=overlay', '-p', '127.0.0.1::3306', '--tmpfs', '/var/lib/mysql', 'mysql:9')
const dbPort = Number(docker('port', db, '3306/tcp').split('\n')[0].split(':').pop())
for (let i = 0; ; i++) {
  try {
    docker('exec', db, 'mysql', '-h127.0.0.1', '-uroot', `-p${password}`, '-e', 'select 1')
    break
  } catch {
    if (i > 120) throw new Error('mysql did not start')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// ---- modules, staged as a deployment places them
const work = mkdtempSync(join(tmpdir(), 'overlay-lab-'))
symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'))
const apps = [
  { app: 'bfinger', bundle: 'bfinger/host/bundle/index.js', topics: ['tm_finger'], env: {} },
  { app: 'bbox', bundle: 'bbox/host/bundle/bbox-module.js', topics: ['tm_bbox_example_office_qzxkvbmwtr'], env: { BBOX_OFFICES: 'example_office_qzxkvbmwtr' } },
  { app: 'borg', bundle: 'borg/host/bundle/borg-module.js', topics: ['tm_borg_example_hall_vkqzmtrwxp'], env: { BORG_HALLS: 'example_hall_vkqzmtrwxp' } },
  { app: 'bsecret', bundle: 'bsecret/host/bundle/bsecret-module.js', topics: ['tm_bsecret_example_crypt_hmqzvtkwrx'], env: { BSECRET_CRYPTS: 'example_crypt_hmqzvtkwrx' } },
  { app: 'bchat', bundle: 'bchat/host/bundle/bchat-module.js', topics: ['tm_bchat_example_team_hmqzvtkwrx'], env: { BCHAT_WORKSPACES: 'example_team_hmqzvtkwrx' } },
  { app: 'blogs', bundle: 'blogs/host/bundle/blogs-module.js', topics: ['tm_log_example_app_qzxkvbmwtr'], env: { BLOGS_STREAMS: 'example_app_qzxkvbmwtr=open' } },
  { app: 'bstore', bundle: 'bstore/host/bundle/bstore-module.js', topics: ['tm_bstore_example_photos_hmqzvtkwrx', 'tm_bstoreblob_example_photos_hmqzvtkwrx'], env: { BSTORE_BUCKETS: 'example_photos_hmqzvtkwrx' } },
]
const mounted = []
const modEnv = {}
const topics = ['tm_lab_a', 'tm_lab_b']

// A probe module that uses what the host hands a module: routes under its
// own lookup name, the engine's submit and evict, the chain tracker, and the
// reorg and shutdown listeners.
const PROBE = `import { writeFileSync } from 'node:fs'
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c) }
export default (host) => {
  const reorgs = []
  host.onReorg((e) => { reorgs.push(e) })
  host.onShutdown(() => { writeFileSync(process.env.LAB_PROBE_MARKER, 'clean') })
  host.route('/ls_probe/state', async (req, res) => { res.end(JSON.stringify({ reorgs, tip: await host.chainTracker.currentHeight() })) })
  host.route('/ls_probe/submit', async (req, res) => { res.end(JSON.stringify(await host.engine.submit([...(await body(req))], [req.headers['x-topics']]))) })
  host.route('/ls_probe/evict', async (req, res) => {
    const u = new URL(req.url, 'http://probe')
    res.end(JSON.stringify(await host.engine.evict(u.searchParams.get('txid'), { topic: u.searchParams.get('topic'), reason: 'lab' })))
  })
  return { lookups: { ls_probe: {
    admissionMode: 'locking-script', spendNotificationMode: 'none', outputAdmittedByTopic() {}, lookup: async () => [],
    getDocumentation: async () => '', getMetaData: async () => ({ name: 'ls_probe', shortDescription: 'lab probe' }),
  } } }
}
`
{
  const dir = join(work, 'modules', 'probe')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.mjs'), PROBE)
  mounted.push({ app: 'probe', file: join(dir, 'module.mjs'), topics: [] })
  modEnv.LAB_PROBE_MARKER = join(work, 'probe-shutdown')
}
for (const a of MODULES === undefined ? [] : apps) {
  const src = join(MODULES, a.bundle)
  if (!existsSync(src)) {
    console.log(`skip  ${a.app}: no bundle at ${src}`)
    continue
  }
  const dir = join(work, 'modules', a.app)
  mkdirSync(join(dir, 'state'), { recursive: true })
  copyFileSync(src, join(dir, 'module.js'))
  mounted.push({ ...a, file: join(dir, 'module.js') })
  topics.push(...a.topics)
  Object.assign(modEnv, a.env)
  const prefix = a.app.toUpperCase()
  if (a.app !== 'bfinger' && a.app !== 'blogs') modEnv[`${prefix}_STATE_DIR`] = join(dir, 'state')
}

// ---- the host
let host
let hostLog = ''
const port = 28_000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
async function start() {
  hostLog = ''
  const t0 = Date.now()
  host = spawn(process.execPath, [join(repo, 'dist/index.js')], {
    env: {
      PATH: process.env.PATH ?? '',
      ...modEnv,
      OVERLAY_TOPICS: topics.join(','),
      OVERLAY_MODULES: mounted.map((m) => m.file).join(','),
      OVERLAY_KNEX_URL: `mysql://root:${password}@127.0.0.1:${dbPort}/overlay`,
      OVERLAY_CHAIN_TRACKER_URL: headerURL,
      OVERLAY_ADMIN_TOKEN: 'lab',
      OVERLAY_LISTEN: '127.0.0.1',
      OVERLAY_PORT: String(port),
      OVERLAY_REORG_POLL_SECONDS: '1',
      OVERLAY_VERIFY_WORKERS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', (d) => (hostLog += d))
  host.stderr.on('data', (d) => (hostLog += d))
  for (let i = 0; i < 600; i++) {
    if (hostLog.includes('listening')) return Date.now() - t0
    if (host.exitCode !== null) throw new Error(`host exited:\n${hostLog}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`host did not listen:\n${hostLog}`)
}
async function stop() {
  host.kill('SIGTERM')
  await new Promise((r) => host.once('exit', r))
}
async function submit(beef, topic) {
  const r = await fetch(`${base}/submit`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-topics': topic }, body: Buffer.from(beef) })
  return { status: r.status, body: await r.json() }
}
async function lookup(query, service = 'ls_anytx') {
  const r = await fetch(`${base}/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service, query }) })
  return await r.json()
}
async function metric(series) {
  const text = await (await fetch(`${base}/metrics`)).text()
  const line = text.split('\n').find((l) => l.startsWith(series + ' '))
  return line === undefined ? undefined : Number(line.split(' ').pop())
}
async function walk() {
  const keys = []
  let after
  for (;;) {
    const a = await lookup(after === undefined ? { all: true } : { all: true, after })
    if (a.outputs.length === 0) return keys
    for (const o of a.outputs) {
      const tx = Transaction.fromBEEF(o.beef)
      keys.push(`${tx.id('hex')}.${o.outputIndex}`)
    }
    after = keys[keys.length - 1]
  }
}
async function until(what, cond, ms = 15_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await cond()) return ok(what)
    await new Promise((r) => setTimeout(r, 250))
  }
  bad(what)
}

try {
  const startMs = await start()
  ok(`host started in ${startMs} ms on an empty database`)
  const loadedLines = hostLog.split('\n').filter((l) => l.includes('module loaded'))
  expect(`all ${mounted.length} staged modules mounted (${mounted.map((m) => m.app).join(',')})`, loadedLines.length === mounted.length)

  // ---- load: objects to both parity topics, concurrently
  const objs = []
  for (let i = 0; i < OBJECTS; i++) objs.push(await child(1 + (i % 3)))
  const want = new Set()
  let next = 0
  let refused = 0
  const t0 = Date.now()
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < objs.length) {
      const i = next++
      const tx = objs[i]
      const r = await submit(tx.toBEEF(), i % 2 === 0 ? 'tm_lab_a' : 'tm_lab_b')
      if (r.status !== 200) refused++
      for (let o = 0; o < tx.outputs.length; o++) want.add(`${tx.id('hex')}.${o}`)
    }
  }))
  const secs = (Date.now() - t0) / 1000
  expect(`${OBJECTS} objects admitted (${Math.round(OBJECTS / secs)}/s)`, refused === 0)
  expect('the scripts were verified on the worker pool', ((await metric('overlay_host_verified_in_workers_total')) ?? 0) >= OBJECTS)

  const before = await walk()
  expect(`the parity walk answers every admitted outpoint once, sorted (${before.length})`,
    before.length === want.size && before.every((k) => want.has(k)) && before.join() === [...before].sort().join())

  // ---- a tampered object is refused
  const forged = await child(1)
  forged.outputs[0].satoshis = 999
  expect('an object whose signature does not cover it is refused', (await submit(forged.toBEEF(), 'tm_lab_a')).status === 400)

  // ---- proof upgrade, reorg, replacement
  const u = await child(1)
  const uid = u.id('hex')
  expect('an unproven object is admitted', (await submit(u.toBEEF(), 'tm_lab_a')).body.tm_lab_a?.outputsToAdmit?.length === 1)
  const h1 = ++height
  const p1 = Transaction.fromBEEF(u.toBEEF())
  mine(p1, h1)
  tip = h1 + 2
  await submit(p1.toAtomicBEEF(), 'tm_lab_a')
  expect('its proof, sent later, is ingested', (await metric('overlay_host_proof_ingests_total{result="upgraded"}')) === 1)

  roots.set(h1, rand()) // block h1 is replaced by another block
  await until('the reorg watch demotes the admission in the block that left', async () => ((await metric('overlay_host_reorg_demoted_total')) ?? 0) >= 1)
  const state = await (await fetch(`${base}/ls_probe/state`)).json()
  expect('a module hears of the reorg, with the block and the admission', state.reorgs.length === 1 &&
    state.reorgs[0].disconnected[0]?.height === h1 && state.reorgs[0].demoted.some((d) => d.txid === uid && d.topic === 'tm_lab_a'))
  expect('a module reads the host\'s chain tracker', state.tip === tip)
  const h2 = h1 + 1
  const p2 = Transaction.fromBEEF(u.toBEEF())
  mine(p2, h2)
  await submit(p2.toAtomicBEEF(), 'tm_lab_a')
  expect('the new proof replaces the stale one', (await metric('overlay_host_proof_ingests_total{result="replaced"}')) === 1)
  const answered = await lookup({ outpoint: `${uid}.0` })
  const served = Transaction.fromBEEF(answered.outputs[0].beef, uid)
  expect('the host now answers with the new block\'s path', served.merklePath?.blockHeight === h2)
  await submit(p2.toAtomicBEEF(), 'tm_lab_a')
  expect('the same proof again writes nothing', (await metric('overlay_host_proof_ingests_total{result="already"}')) === 1)

  // ---- a module submits, evicts, and submits again
  const m = await child(1)
  const mid = m.id('hex')
  const viaModule = async () => await (await fetch(`${base}/ls_probe/submit`, { method: 'POST', headers: { 'x-topics': 'tm_lab_b' }, body: Buffer.from(m.toBEEF()) })).json()
  expect('a module submits through the host', (await viaModule()).tm_lab_b?.outputsToAdmit?.length === 1)
  expect('a second submission is a duplicate', (await viaModule()).tm_lab_b?.outputsToAdmit?.length === 0)
  const ev = await (await fetch(`${base}/ls_probe/evict?txid=${mid}&topic=tm_lab_b`)).json()
  expect('a module evicts an admission', ev.evictedOutputs === 1 && ev.evictedTransactions === 1)
  expect('the evicted output is no longer answered', (await lookup({ outpoint: `${mid}.0` })).outputs.length === 0)
  expect('the evicted object offered again is decided afresh', (await viaModule()).tm_lab_b?.outputsToAdmit?.length === 1)

  // ---- restart
  await stop()
  expect('a module\'s shutdown listener ran before the host stopped', existsSync(modEnv.LAB_PROBE_MARKER) && readFileSync(modEnv.LAB_PROBE_MARKER, 'utf8') === 'clean')
  const restartMs = await start()
  ok(`host restarted in ${restartMs} ms`)
  const restoredLines = hostLog.split('\n').filter((l) => l.includes('module loaded'))
  expect('every module mounted again', restoredLines.length === mounted.length)
  const after = await walk()
  expect('the parity walk answers the same after a restart', after.join() === [...before, `${uid}.0`, `${mid}.0`].sort().join())
  await stop()
} catch (err) {
  bad(String(err?.stack ?? err))
  if (hostLog !== '') console.log(hostLog.split('\n').slice(-30).join('\n'))
} finally {
  try {
    if (host?.exitCode === null) host.kill('SIGKILL')
  } catch {}
  docker('rm', '-f', db)
  headers.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(failures === 0 ? 'lab: PASS' : `lab: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)

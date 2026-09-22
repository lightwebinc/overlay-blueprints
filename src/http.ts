import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Engine } from '@bsv/overlay'
import type { Metrics } from './metrics.js'

export interface HttpDeps {
  readonly engine: Engine
  readonly metrics: Metrics
  readonly adminToken: string
  readonly topics: readonly string[]
  readonly ready: () => boolean
  readonly log: (msg: string, extra?: Record<string, unknown>) => void
}

const MAX_BODY = 64 * 1024 * 1024 // matches the bridge's object ceiling

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}

/**
 * Parse `x-topics` in both wire forms, because clients written against either
 * engine send different ones: a JSON array from the SDK's own facilitator, a
 * comma list from the generated server's binder. Values are trimmed, and a
 * repeated header is an error rather than a silent first-value read that
 * would lose topics without saying so.
 */
export function parseTopics(raw: string | string[] | undefined): string[] {
  if (raw === undefined) throw new Error('missing x-topics header')
  if (Array.isArray(raw)) throw new Error('x-topics sent more than once; send one header')
  const t = raw.trim()
  if (t === '') throw new Error('empty x-topics header')
  const names: unknown = t.startsWith('[') ? JSON.parse(t) : t.split(',')
  if (!Array.isArray(names)) throw new Error('x-topics is not a list')
  const out = names.map((n) => String(n).trim())
  // An empty entry means the client built the header wrong. Dropping it
  // silently would lose a topic the client believes it submitted to, so it is
  // an error, exactly as it is on the bridge's facade.
  if (out.some((n) => n === '')) throw new Error('x-topics contains an empty topic name')
  if (out.length === 0) throw new Error('x-topics names no topics')
  return [...new Set(out)]
}

export function buildServer(d: HttpDeps): Server {
  d.metrics.preset('overlay_host_submits_total', { result: 'ok' })
  d.metrics.preset('overlay_host_submits_total', { result: 'malformed' })
  d.metrics.preset('overlay_host_submits_total', { result: 'error' })
  d.metrics.preset('overlay_host_gasp_syncs_total', { result: 'ok' })
  d.metrics.preset('overlay_host_gasp_syncs_total', { result: 'error' })

  return createServer((req, res) => {
    void handle(d, req, res).catch((err: unknown) => {
      d.log('request failed', { err: String(err) })
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    })
  })
}

async function handle(d: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://host')
  const path = url.pathname

  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200).end('ok')
    return
  }
  if (req.method === 'GET' && path === '/readyz') {
    // Readiness gates on storage being migrated and the chain tracker
    // answering. Reporting ready before then invites a client to submit into
    // a host that cannot verify.
    if (!d.ready()) {
      json(res, 503, { ready: false })
      return
    }
    json(res, 200, { ready: true })
    return
  }
  if (req.method === 'GET' && path === '/metrics') {
    const body = d.metrics.render()
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body)
    return
  }

  // ---- BRC-22 submit, mounted at the ROOT, as the released Express server
  // does. A client pointed at this host must not need a different base path.
  if (req.method === 'POST' && path === '/submit') {
    let topics: string[]
    try {
      topics = parseTopics(req.headers['x-topics'])
    } catch (err) {
      d.metrics.inc('overlay_host_submits_total', { result: 'malformed' })
      json(res, 400, { error: String((err as Error).message) })
      return
    }
    const unknown = topics.filter((t) => !d.topics.includes(t))
    if (unknown.length > 0) {
      d.metrics.inc('overlay_host_submits_total', { result: 'malformed' })
      json(res, 400, { error: `this host does not carry: ${unknown.join(', ')}` })
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch {
      d.metrics.inc('overlay_host_submits_total', { result: 'malformed' })
      json(res, 413, { error: 'body too large' })
      return
    }
    if (body.length === 0) {
      d.metrics.inc('overlay_host_submits_total', { result: 'malformed' })
      json(res, 400, { error: 'missing or empty BEEF body' })
      return
    }
    try {
      const steak = await d.engine.submit({ beef: [...body], topics }, undefined, 'current-tx')
      d.metrics.inc('overlay_host_submits_total', { result: 'ok' })
      for (const t of topics) d.metrics.inc('overlay_host_admissions_total', { topic: t })
      // Answer the BARE map, as the released TypeScript engine does. A client
      // that worked against that engine keeps working here.
      json(res, 200, steak)
    } catch (err) {
      d.metrics.inc('overlay_host_submits_total', { result: 'error' })
      d.log('submit failed', { err: String(err) })
      json(res, 400, { error: String((err as Error).message) })
    }
    return
  }

  // ---- BRC-24 lookup
  if (req.method === 'POST' && path === '/lookup') {
    const body = await readBody(req)
    try {
      const question = JSON.parse(body.toString('utf8')) as { service: string; query: unknown }
      const answer = await d.engine.lookup(question)
      json(res, 200, answer)
    } catch (err) {
      json(res, 400, { error: String((err as Error).message) })
    }
    return
  }

  // ---- Admin. One authenticated trigger, so the drills that exercise
  // catch-up run identically here and on a stock server, which offers the
  // same route. Without it this host's backfill path could only ever be
  // exercised by its own startup and would go into the drills unproven.
  if (path.startsWith('/admin/')) {
    const auth = req.headers.authorization
    const expected = `Bearer ${d.adminToken}`
    // Length-independent compare is not worth it here (the token is a local
    // secret on a host with no public door), but an absent header must not
    // be a pass.
    if (typeof auth !== 'string' || auth !== expected) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'POST' && path === '/admin/startGASPSync') {
      try {
        await d.engine.startGASPSync()
        d.metrics.inc('overlay_host_gasp_syncs_total', { result: 'ok' })
        json(res, 200, { status: 'ok' })
      } catch (err) {
        d.metrics.inc('overlay_host_gasp_syncs_total', { result: 'error' })
        d.log('GASP sync failed', { err: String(err) })
        json(res, 500, { error: String((err as Error).message) })
      }
      return
    }
    json(res, 404, { error: 'no such admin route' })
    return
  }

  json(res, 404, { error: 'not found' })
}

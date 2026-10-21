/**
 * Script verification on more than one core.
 *
 * The engine verifies every submission with the SDK's `Transaction.verify`,
 * and on a busy host the script interpreter, ECDSA for a P2PKH input, is
 * most of the engine's single thread (measured: docs/scaling.md). The SDK
 * has a documented seam for exactly this, a process-wide script
 * verification backend (`registerScriptVerificationBackend`): `verify` still
 * walks the BEEF, checks every merkle path against the chain tracker, checks
 * amounts and fees on the engine's thread, and hands each unmined
 * transaction's scripts to the backend, then fails the whole verification if
 * any verdict is false. This backend sends them to a pool of worker threads
 * that run the SDK's own interpreter (verifyworker.ts), so the verdict is
 * the one the inline path would have reached, and the engine is not changed.
 *
 * What differs is only how a refusal reads: the inline interpreter throws
 * its own message from `verify`, and the backend path throws the SDK's
 * "Script verification failed for transaction <txid>". Both reach the
 * submitter as a 400.
 */
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import {
  registerScriptVerificationBackend,
  unregisterScriptVerificationBackend,
  type BdkVerifyScriptsParams,
  type ScriptVerificationBackend,
  type Spend,
} from '@bsv/sdk'
import { verifyScripts, type VerifyAnswer, type VerifyJob } from './verifyworker.js'

/** How one script verification ended: a verdict either way, or a fault. */
export type VerifyResult = 'ok' | 'refused' | 'error'

/**
 * Where a verification ran: a worker, inline on the engine's thread, or not
 * here at all because the overlay bridge on this machine already ran it
 * (a trusted marker, src/bridgetrust.ts).
 */
export type VerifyPath = 'worker' | 'inline' | 'bridge'

/**
 * The default pool: two workers, or one on a two-core machine, none on one.
 * Measured, more do not help: with scripts off the engine's thread, what is
 * left on it (BEEF parsing, the database client, HTTP) costs about as much
 * per object as the scripts did, so two workers keep it busy, and each worker
 * holds its own copy of the SDK (about 80 MiB resident).
 */
export function defaultWorkers(): number {
  return Math.max(0, Math.min(2, availableParallelism() - 1))
}

interface Pending {
  resolve: (v: boolean) => void
  reject: (e: Error) => void
}

export class VerifyPool {
  private readonly workers: Worker[] = []
  private readonly load: number[] = []
  private readonly pending = new Map<number, Pending & { worker: number }>()
  private nextId = 1
  private backend: ScriptVerificationBackend | undefined
  private closed = false

  /** Transactions verified in workers, and how many were refused. */
  verified = 0
  refused = 0

  /**
   * Told of every verification this pool answers, with its end-to-end time
   * in seconds (queueing in the pool included) and where it ran. A pool of
   * size 0 runs the same interpreter inline, on the calling thread.
   */
  onVerified: ((seconds: number, result: VerifyResult, path: VerifyPath) => void) | undefined

  /** Verifications skipped because the bridge had run them. */
  skipped = 0

  /**
   * Transactions whose scripts the bridge verified, by txid, counted by the
   * submissions in flight that carry them. A txid commits to the
   * transaction's unlocking scripts and to every source txid, and so to every
   * locking script and amount its scripts are checked against: a verdict
   * about a txid holds for any submission carrying that txid.
   */
  private readonly trusted = new Map<string, number>()

  get path(): 'worker' | 'inline' {
    return this.size > 0 ? 'worker' : 'inline'
  }

  private observe(start: bigint, result: VerifyResult, path: VerifyPath = this.path): void {
    this.onVerified?.(Number(process.hrtime.bigint() - start) / 1e9, result, path)
  }

  /**
   * Skip script verification for these txids until the returned release is
   * called. Call it around ONE submission whose marker was accepted, and
   * release in a finally.
   */
  trust(txids: readonly string[]): () => void {
    for (const id of txids) this.trusted.set(id, (this.trusted.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of txids) {
        const n = (this.trusted.get(id) ?? 1) - 1
        if (n <= 0) this.trusted.delete(id)
        else this.trusted.set(id, n)
      }
    }
  }

  /** Txids currently trusted (for tests and a gauge). */
  get trustedCount(): number {
    return this.trusted.size
  }

  constructor(readonly size: number) {
    const url = new URL('./verifyworker.js', import.meta.url)
    for (let i = 0; i < size; i++) this.spawn(url, i)
  }

  private spawn(url: URL, i: number): void {
    const w = new Worker(url)
    w.unref()
    w.on('message', (a: VerifyAnswer) => {
      const p = this.pending.get(a.id)
      if (p === undefined) return
      this.pending.delete(a.id)
      this.load[i] = (this.load[i] ?? 1) - 1
      this.verified++
      if (!a.valid) this.refused++
      p.resolve(a.valid)
    })
    const fail = (err: Error): void => {
      // Every job the worker held fails as a backend fault (verify rejects,
      // the submission is refused and can be offered again), and a new
      // worker takes its place.
      for (const [id, p] of this.pending) {
        if (p.worker !== i) continue
        this.pending.delete(id)
        p.reject(err)
      }
      this.load[i] = 0
      if (!this.closed) this.spawn(url, i)
    }
    w.on('error', fail)
    w.on('exit', (code) => {
      if (!this.closed && code !== 0) fail(new Error(`script verification worker exited with ${code}`))
    })
    this.workers[i] = w
    this.load[i] = 0
  }

  /** Verifies every input script of a transaction whose inputs carry their sources. */
  run(params: BdkVerifyScriptsParams): Promise<boolean> {
    const start = process.hrtime.bigint()
    if (this.trusted.size > 0 && this.trusted.has(params.tx.id('hex'))) {
      this.skipped++
      this.observe(start, 'ok', 'bridge')
      return Promise.resolve(true)
    }
    let job: VerifyJob
    try {
      job = this.job(params)
    } catch (err) {
      this.observe(start, 'error')
      return Promise.reject(err as Error)
    }
    if (this.size === 0) {
      const a = verifyScripts(job)
      this.verified++
      if (!a.valid) this.refused++
      this.observe(start, a.valid ? 'ok' : 'refused')
      return Promise.resolve(a.valid)
    }
    // The least loaded worker; ties go to the lowest index.
    let w = 0
    for (let i = 1; i < this.workers.length; i++) if ((this.load[i] ?? 0) < (this.load[w] ?? 0)) w = i
    this.load[w] = (this.load[w] ?? 0) + 1
    return new Promise<boolean>((resolve, reject) => {
      this.pending.set(job.id, {
        resolve: (v) => {
          this.observe(start, v ? 'ok' : 'refused')
          resolve(v)
        },
        reject: (e) => {
          this.observe(start, 'error')
          reject(e)
        },
        worker: w,
      })
      this.workers[w]!.postMessage(job)
    })
  }

  private job(params: BdkVerifyScriptsParams): VerifyJob {
    const tx = params.tx
    const sources = tx.inputs.map((input) => {
      const out = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (out === undefined) throw new Error('an input has no source output')
      return { satoshis: out.satoshis ?? 0, lockingScript: out.lockingScript.toUint8Array() }
    })
    return { id: this.nextId++, raw: tx.toUint8Array(), sources }
  }

  /** Jobs sent and not yet answered. */
  get inFlight(): number {
    return this.pending.size
  }

  /** Makes this pool the process's script verification backend. */
  install(): void {
    const backend: ScriptVerificationBackend = {
      // The pool does not apply a memory limit, so the SDK keeps the inline
      // interpreter for any call that sets one.
      supportsMemoryLimit: false,
      verifyScripts: async (params) => await this.run(params),
      // A single Spend validated through the SDK's async lane stays inline:
      // nothing in the engine takes that lane, and it needs no copy.
      verifySpend: async (spend: Spend) => spend.validateJavaScript(),
    }
    registerScriptVerificationBackend(backend)
    this.backend = backend
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.backend !== undefined) unregisterScriptVerificationBackend(this.backend)
    await Promise.all(this.workers.map(async (w) => await w.terminate()))
  }
}

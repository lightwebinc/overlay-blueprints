/**
 * A script verification worker: runs the SDK's own JavaScript interpreter on
 * one transaction's inputs, off the engine's thread.
 *
 * Each input's Spend is built exactly as `Transaction.verify` builds it on
 * its inline path (sdk 2.7.1, verifyTransactionInputs): the same source
 * txid, locking script and satoshis, the transaction's own version, inputs,
 * outputs and lock time, one sighash cache shared by the transaction's
 * inputs, and no memory limit. The verdict is the interpreter's.
 */
import { parentPort } from 'node:worker_threads'
import { LockingScript, Spend, Transaction } from '@bsv/sdk'

export interface VerifyJob {
  readonly id: number
  /** The transaction's serialization. */
  readonly raw: Uint8Array
  /** Per input: what its source output holds. */
  readonly sources: ReadonlyArray<{ satoshis: number; lockingScript: Uint8Array }>
}

export interface VerifyAnswer {
  readonly id: number
  readonly valid: boolean
  readonly error?: string
}

export function verifyScripts(job: Omit<VerifyJob, 'id'>): { valid: boolean; error?: string } {
  try {
    const tx = Transaction.fromBinary(Array.from(job.raw))
    if (tx.inputs.length !== job.sources.length) return { valid: false, error: 'source count does not match the inputs' }
    const sigHashCache = { hashOutputsSingle: new Map() }
    for (let index = 0; index < tx.inputs.length; index++) {
      const input = tx.inputs[index]!
      const source = job.sources[index]!
      const ok = new Spend({
        sourceTXID: input.sourceTXID as string,
        sourceOutputIndex: input.sourceOutputIndex,
        lockingScript: LockingScript.fromBinary(Array.from(source.lockingScript)),
        sourceSatoshis: source.satoshis,
        transactionVersion: tx.version,
        otherInputs: [],
        allInputs: tx.inputs,
        unlockingScript: input.unlockingScript!,
        inputSequence: input.sequence ?? 0xffffffff,
        inputIndex: index,
        outputs: tx.outputs,
        lockTime: tx.lockTime,
        memoryLimit: undefined,
        sigHashCache,
      } as ConstructorParameters<typeof Spend>[0]).validateJavaScript()
      if (!ok) return { valid: false }
    }
    return { valid: true }
  } catch (err) {
    return { valid: false, error: String((err as Error)?.message ?? err) }
  }
}

if (parentPort !== null) {
  const port = parentPort
  port.on('message', (job: VerifyJob) => {
    const answer: VerifyAnswer = { id: job.id, ...verifyScripts(job) }
    port.postMessage(answer)
  })
}

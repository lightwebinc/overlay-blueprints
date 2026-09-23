import type { TopicManager, AdmittanceInstructions } from '@lightwebinc/overlay'
import { Transaction } from '@bsv/sdk'

/**
 * `tm_anytx` admits every output of every object it is given.
 *
 * This is the phase-0 topic manager, and it is deliberately trivial. The thing
 * it exists to serve is the parity oracle: a fixed object set is submitted to
 * two hosts and their lookup answers are compared, and the comparison is only
 * meaningful if the two hosts cannot disagree for any reason other than the
 * one under test. A selective manager would add a second thing that can
 * differ, and an admittance rule is not what the bridge is being measured on.
 *
 * It is not a template for a real overlay. A real topic manager decides what
 * belongs in its topic; this one decides nothing, which is why it is named for
 * what it does.
 */
export class AnyTxTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], _previousCoins: number[]): Promise<AdmittanceInstructions> {
    // Parse only to count outputs. Any failure is a refusal, never a throw
    // that would read to the engine as a host fault: the object arrived from
    // an open plane and whatever it is, it is the sender's problem.
    try {
      const tx = Transaction.fromBEEF(beef)
      return { outputsToAdmit: tx.outputs.map((_, i) => i), coinsToRetain: [] }
    } catch {
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

  /** Nothing is needed: admittance does not depend on any previous output. */
  async identifyNeededInputs(): Promise<Array<{ txid: string; outputIndex: number }>> {
    return []
  }

  async getDocumentation(): Promise<string> {
    return [
      '# tm_anytx',
      '',
      'Admits every output of every object submitted to it.',
      '',
      'This is a reference and parity-oracle topic manager, not an example to',
      'copy: a real topic manager decides what belongs in its topic.',
    ].join('\n')
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return { name: 'tm_anytx', shortDescription: 'Admits every output. Reference and parity oracle.' }
  }
}

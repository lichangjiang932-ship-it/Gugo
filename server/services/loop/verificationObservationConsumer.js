// @ts-check
import { planVerificationObservation } from './verificationObservationStage.js'
/** Production consumer of the narrow port; the host exposes only four effect operations.
 * @param {import('../../../types/verification-stage.js').VerificationStageInput} input
 * @param {import('../../../types/verification-stage.js').VerificationStagePorts} ports
 * @param {import('../../../types/verification-stage.js').VerificationEffectHost} host
 */
export function consumeVerificationObservation(input, ports, host) {
  const effect = planVerificationObservation(input, ports)
  if (effect.progress) { host.markProgress(); host.resetRetries() }
  for (const message of effect.messages) host.appendMessage(message)
  for (const read of effect.htmlReads) host.retainHtml(read.path, read.content)
  return effect
}

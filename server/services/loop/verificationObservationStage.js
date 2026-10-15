// @ts-check
/** @typedef {import('../../../types/verification-stage.js').VerificationStageInput} Input */
/** @typedef {import('../../../types/verification-stage.js').VerificationStagePorts} Ports */
/** @typedef {import('../../../types/verification-stage.js').VerificationStageEffect} Effect */

/** No global bag or mutable Loop state is accepted by this stage.
 * @param {Input} input
 * @param {Ports} ports
 * @returns {Effect}
 */
export function planVerificationObservation(input, ports) {
  for (const key of /** @type {const} */ (['observe', 'repairPrompt', 'normalizeTarget', 'targetsMatch'])) {
    if (typeof ports[key] !== 'function') throw new TypeError(`verification stage requires ${key}`)
  }
  const observation = ports.observe(input.call, input.result)
  const progress = Boolean(observation.changed && !observation.failed && !observation.indeterminate)
  /** @type {{role:'system',content:string}[]} */
  const messages = []
  if (observation.failed || observation.indeterminate) {
    const prompt = ports.repairPrompt()
    if (prompt) messages.push({ role: 'system', content: prompt })
  }
  /** @type {{path:string,content:string}[]} */
  const htmlReads = []
  if (input.succeeded && input.call.name === 'read_file' && typeof input.result.content === 'string' && input.result.truncated !== true) {
    const targets = [input.result.path, input.call.args?.path].map(ports.normalizeTarget).filter(Boolean)
    for (const path of input.htmlTargets) {
      if (targets.some(candidate => ports.targetsMatch(candidate, path, input.executionScope))) htmlReads.push({ path, content: input.result.content })
    }
  }
  return Object.freeze({ progress, messages: Object.freeze(messages.map(message => Object.freeze(message))), htmlReads: Object.freeze(htmlReads.map(read => Object.freeze(read))) })
}

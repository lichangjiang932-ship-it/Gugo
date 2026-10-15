import { planVerificationObservation } from '../../server/services/loop/verificationObservationStage.js'
import { consumeVerificationObservation } from '../../server/services/loop/verificationObservationConsumer.js'
import { createLoopExecutionScope } from '../../server/services/loop/executionScope.js'
import type { VerificationStageInput, VerificationStagePorts } from '../verification-stage.js'
const input: VerificationStageInput = { call: { name: 'read_file' }, result: { content: 'data' }, succeeded: true, htmlTargets: [], executionScope: createLoopExecutionScope({job: {}, step: {}}) }
const ports: VerificationStagePorts = { observe: () => ({changed:true}), repairPrompt: () => '', normalizeTarget: value => String(value), targetsMatch: (a,b) => a===b }
planVerificationObservation(input, ports)
consumeVerificationObservation(input, ports, { markProgress() {}, resetRetries() {}, appendMessage() {}, retainHtml() {} })

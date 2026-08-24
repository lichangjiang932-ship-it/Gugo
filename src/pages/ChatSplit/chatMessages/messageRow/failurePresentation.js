import {
  isModelSetupFailure,
  isRuntimeUnavailableFailure,
} from '../../../../lib/chatFlowGuards.js'

export function failurePresentation(msg) {
  const modelSetupFailure = msg.meta?.failed === true && isModelSetupFailure(msg)
  const runtimeRestartRequired = msg.meta?.failed === true
    && msg.meta?.serverFailure?.action === 'restart_runtime'
    && isRuntimeUnavailableFailure(msg)
  return {
    modelSetupFailure,
    runtimeRestartRequired,
  }
}

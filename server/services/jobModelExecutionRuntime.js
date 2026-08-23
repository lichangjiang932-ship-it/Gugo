import { callBackgroundModel, callBackgroundModelWithTools } from '../adapters/modelProxy.js'

export async function runDefaultJobModel({
  messages, signal, userId, usageOwnerId = userId, modelName, modelEnv,
}) {
  return callBackgroundModel({
    messages,
    signal,
    userId: modelEnv ? null : userId,
    usageOwnerId,
    modelName,
    ...(modelEnv ? { env: modelEnv } : {}),
  })
}

export async function runDefaultJobModelWithTools({
  messages, tools, toolChoice, signal, userId, modelName, modelEnv, modelRequestId,
  onProviderAttempt, usageOwnerId = userId,
}) {
  return callBackgroundModelWithTools({
    messages,
    tools,
    toolChoice,
    signal,
    userId: modelEnv ? null : userId,
    usageOwnerId,
    modelName,
    modelRequestId,
    onProviderAttempt,
    ...(modelEnv ? { env: modelEnv } : {}),
  })
}

export function createJobLoopModelBridge({
  job,
  step,
  selectedModel,
  modelEnv,
  runModelWithTools,
  readModelRequestResolution,
  reconcileModelRequest,
}) {
  return {
    run: (options) => runModelWithTools({
      ...options,
      userId: modelEnv ? null : job.userId,
      usageOwnerId: job.userId,
      modelName: selectedModel,
      modelEnv,
    }),
    reconcile: async (invocation) => {
      const manual = typeof readModelRequestResolution === 'function'
        ? await readModelRequestResolution({
            userId: job.userId,
            jobId: job.id,
            stepId: step.id,
            invocation,
          })
        : null
      if (manual) return manual
      if (typeof reconcileModelRequest !== 'function') return null
      return reconcileModelRequest({
        invocation,
        modelName: selectedModel || null,
        modelProviderId: job.modelProviderId || null,
        modelConfigRevision: job.modelConfigRevision ?? null,
        env: modelEnv || process.env,
      })
    },
  }
}

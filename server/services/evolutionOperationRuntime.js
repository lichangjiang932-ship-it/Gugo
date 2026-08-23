import {
  generateEvolutionCandidate,
  getEvolutionCandidate,
} from './evolutionCandidateService.js'
import {
  evaluateEvolutionReplay,
  getEvolutionEvaluation,
} from './evolutionEvaluationService.js'
import {
  assertEvolutionOperationRunnable,
  getEvolutionOperation,
  reconcileExpiredEvolutionOperation,
} from './evolutionOperationService.js'
import {
  getEvolutionReplayRun,
  runEvolutionReplay,
} from './evolutionReplayService.js'

function completedResult(userId, operation) {
  if (operation.result?.type === 'candidate') {
    return { candidate: getEvolutionCandidate({ userId, id: operation.result.id }) }
  }
  if (operation.result?.type === 'replay') {
    return { replay: getEvolutionReplayRun({ userId, id: operation.result.id }) }
  }
  if (operation.result?.type === 'evaluation') {
    return { evaluation: getEvolutionEvaluation({ userId, id: operation.result.id }) }
  }
  throw Object.assign(new Error('completed operation result is invalid'), {
    code: 'EVOLUTION_OPERATION_RESULT_INVALID',
    statusCode: 409,
    operationId: operation.id,
  })
}

export async function resumeEvolutionOperation({
  userId,
  id,
  signal,
  runCandidateModel,
  runReplayModel,
  runEvaluationModel,
} = {}) {
  let operation = getEvolutionOperation({ userId, id, includePayload: true })
  if (operation.state === 'running') {
    operation = reconcileExpiredEvolutionOperation({ userId, id })
  }
  if (operation.state === 'completed') {
    const publicOperation = getEvolutionOperation({ userId, id: operation.id })
    return { operation: publicOperation, ...completedResult(userId, publicOperation) }
  }
  assertEvolutionOperationRunnable(operation)
  const request = operation.request || {}
  let result
  if (operation.kind === 'candidate') {
    result = {
      candidate: await generateEvolutionCandidate({
        userId,
        kind: request.kind,
        target: request.target,
        objective: request.objective,
        datasetFingerprint: request.datasetFingerprint,
        sourceRecordIds: request.sourceRecordIds,
        providerId: request.providerId,
        modelName: request.modelName,
        operationId: operation.id,
        now: operation.createdAt,
        signal,
        ...(typeof runCandidateModel === 'function' ? { runModel: runCandidateModel } : {}),
      }),
    }
  } else if (operation.kind === 'replay') {
    result = {
      replay: await runEvolutionReplay({
        userId,
        suiteId: request.suiteId,
        candidateId: request.candidateId,
        baselineContent: request.baselineContent,
        providerId: request.providerId,
        modelName: request.modelName,
        parameters: request.parameters,
        operationId: operation.id,
        now: operation.createdAt,
        signal,
        ...(typeof runReplayModel === 'function' ? { runModel: runReplayModel } : {}),
      }),
    }
  } else if (operation.kind === 'evaluation') {
    result = {
      evaluation: await evaluateEvolutionReplay({
        userId,
        replayId: request.replayId,
        evaluatorProviderId: request.evaluatorProviderId,
        evaluatorModelName: request.evaluatorModelName,
        operationId: operation.id,
        now: operation.createdAt,
        signal,
        ...(typeof runEvaluationModel === 'function' ? { runModel: runEvaluationModel } : {}),
      }),
    }
  } else {
    throw Object.assign(new Error('operation kind is invalid'), {
      code: 'EVOLUTION_OPERATION_KIND_INVALID',
      statusCode: 409,
      operationId: operation.id,
    })
  }
  return {
    operation: getEvolutionOperation({ userId, id: operation.id }),
    ...result,
  }
}

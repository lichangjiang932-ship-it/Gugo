import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareSubagentRunPersistencePort } from '../server/core/subagentRunPersistencePort.js'
import { runSubagent } from '../server/services/subagentRuntime.js'

function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return Object.freeze({ promise, resolve })
}

function runDto(input, overrides = {}) {
  return {
    id: input.id,
    userId: input.userId,
    parentSessionId: input.parentSessionId ?? null,
    parentMessageId: input.parentMessageId ?? null,
    agentType: input.agentType || 'general',
    prompt: input.prompt || 'ownership test',
    modelName: input.modelName ?? 'local-test-model',
    modelProviderId: input.modelProviderId ?? 'local-test-provider',
    modelConfigRevision: input.modelConfigRevision ?? 1,
    status: 'running',
    resultText: '',
    trace: input.trace || [],
    tokensIn: null,
    tokensOut: null,
    createdAt: input.createdAt ?? 1,
    finishedAt: null,
    ...overrides,
  }
}

function modelBinding() {
  return {
    modelName: 'local-test-model',
    providerId: 'local-test-provider',
    configRevision: 1,
    env: {},
  }
}

test('concurrent runs with one owner and id grant execution once without terminalizing the winner', async () => {
  const bothInitialReadsFinished = deferred()
  const winnerStartedExecution = deferred()
  const competitorAttemptedCreate = deferred()
  let initialReads = 0
  let createCalls = 0
  let executionCalls = 0
  let storedRun = null
  const terminalStatuses = []

  const persistencePort = prepareSubagentRunPersistencePort({
    id: 'test.subagent-run-ownership',
    apiVersion: 1,
    async createRun(input) {
      createCalls += 1
      if (createCalls === 1) {
        storedRun = runDto(input)
        return storedRun
      }
      await winnerStartedExecution.promise
      competitorAttemptedCreate.resolve()
      throw Object.assign(new Error('subagent run is already claimed'), {
        code: 'SUBAGENT_RUN_ALREADY_CLAIMED',
      })
    },
    async getRun(input) {
      if (initialReads < 2) {
        initialReads += 1
        if (initialReads === 2) bothInitialReadsFinished.resolve()
        await bothInitialReadsFinished.promise
        return null
      }
      if (!storedRun || storedRun.userId !== input.userId || storedRun.id !== input.id) return null
      return storedRun
    },
    markRunning(input) {
      if (!storedRun) throw new Error('subagent run not found')
      storedRun = runDto(storedRun, {
        status: 'running',
        trace: input.trace,
        finishedAt: null,
      })
      return storedRun
    },
    saveRunningTrace(input) {
      if (!storedRun || storedRun.status !== 'running') {
        throw new Error('subagent run is not running')
      }
      storedRun = runDto(storedRun, { trace: input.trace })
      return storedRun
    },
    finishRun(input) {
      if (!storedRun) return null
      terminalStatuses.push(input.status)
      storedRun = runDto(storedRun, {
        status: input.status,
        resultText: input.resultText,
        trace: input.trace,
        finishedAt: input.finishedAt,
      })
      return storedRun
    },
    listRunningRuns() {
      return storedRun?.status === 'running' ? [storedRun] : []
    },
    interruptRunningRun(input) {
      return { userId: input.userId, id: input.id, interrupted: false }
    },
  })

  const options = {
    id: 'shared-run-id',
    userId: 'owner-1',
    type: 'general',
    prompt: 'execute exactly once',
    persistencePort,
    resolveModelBinding: modelBinding,
    invokeSubagentProvider: async () => {
      executionCalls += 1
      winnerStartedExecution.resolve()
      await competitorAttemptedCreate.promise
      return {
        kind: 'handled',
        terminal: { status: 'completed', text: 'winner result' },
        provenance: { decision: 'handled' },
      }
    },
  }

  const outcomes = await Promise.allSettled([
    runSubagent(options),
    runSubagent(options),
  ])
  const winner = outcomes.find((entry) => entry.status === 'fulfilled')
  const competitor = outcomes.find((entry) => entry.status === 'rejected')
  const persisted = await persistencePort.getRun({ userId: 'owner-1', id: 'shared-run-id' })

  assert.deepEqual({
    fulfilled: outcomes.filter((entry) => entry.status === 'fulfilled').length,
    rejected: outcomes.filter((entry) => entry.status === 'rejected').length,
    executionCalls,
    winnerStatus: winner?.value?.status,
    winnerResult: winner?.value?.resultText,
    competitorCode: competitor?.reason?.code,
    terminalStatuses,
    persistedStatus: persisted?.status,
    persistedResult: persisted?.resultText,
    persistedHasCompetitorError: persisted?.trace?.some((event) => (
      event?.type === 'error' || event?.error === competitor?.reason?.message
    )),
  }, {
    fulfilled: 1,
    rejected: 1,
    executionCalls: 1,
    winnerStatus: 'completed',
    winnerResult: 'winner result',
    competitorCode: 'SUBAGENT_RUN_ALREADY_CLAIMED',
    terminalStatuses: ['completed'],
    persistedStatus: 'completed',
    persistedResult: 'winner result',
    persistedHasCompetitorError: false,
  })
})

test('createRun failure preserves the original error and never attempts finishRun', async () => {
  const originalError = Object.assign(new Error('primary persistence write failed'), {
    code: 'SUBAGENT_RUN_CREATE_FAILED',
  })
  let finishCalls = 0
  let providerCalls = 0

  const persistencePort = prepareSubagentRunPersistencePort({
    id: 'test.subagent-run-create-failure',
    apiVersion: 1,
    async createRun() {
      throw originalError
    },
    getRun() {
      return null
    },
    markRunning(input) {
      return runDto(input)
    },
    saveRunningTrace(input) {
      return runDto(input)
    },
    finishRun() {
      finishCalls += 1
      return null
    },
    listRunningRuns() {
      return []
    },
    interruptRunningRun(input) {
      return { userId: input.userId, id: input.id, interrupted: false }
    },
  })

  let observedError = null
  try {
    await runSubagent({
      id: 'create-failure-run',
      userId: 'owner-2',
      type: 'general',
      prompt: 'must not reach execution',
      persistencePort,
      resolveModelBinding: modelBinding,
      invokeSubagentProvider: async () => {
        providerCalls += 1
        throw new Error('provider must not be invoked')
      },
    })
  } catch (error) {
    observedError = error
  }

  assert.deepEqual({
    sameErrorInstance: observedError === originalError,
    code: observedError?.code,
    message: observedError?.message,
    finishCalls,
    providerCalls,
  }, {
    sameErrorInstance: true,
    code: originalError.code,
    message: originalError.message,
    finishCalls: 0,
    providerCalls: 0,
  })
})

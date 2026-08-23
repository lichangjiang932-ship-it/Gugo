import { createHash, randomUUID } from 'node:crypto'

import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { getDb } from '../db.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { buildEvolutionDataset, sanitizeEvolutionText } from './evolutionDatasetService.js'
import {
  assertEvolutionModelIdentityCurrent,
  callEvolutionBackgroundModel,
  resolveEvolutionModelIdentity,
} from './evolutionModelRuntime.js'
import {
  assertEvolutionOperationRunnable,
  attachEvolutionOperationError,
  blockEvolutionOperation,
  checkpointEvolutionOperation,
  claimEvolutionOperation,
  commitEvolutionOperation,
  failEvolutionOperation,
  openEvolutionOperation,
} from './evolutionOperationService.js'
import { holdEvolutionOperationLease } from './evolutionOperationLeaseRuntime.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const MAX_CASES = 10
const MAX_LIMIT = 100

function serviceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function inputText(value, max, code, label, { required = true } = {}) {
  const raw = String(value || '').trim()
  if ((required && !raw) || raw.length > max) {
    throw serviceError(code, `${label} must contain between ${required ? 1 : 0} and ${max} characters`)
  }
  return sanitizeEvolutionText(raw)
}

function timestamp(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw serviceError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  return number
}

function limitValue(value, fallback = 50) {
  if (value == null || value === '') return fallback
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_REPLAY_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function suiteView(row, { includeCases = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    datasetFingerprint: row.dataset_fingerprint,
    curationVersion: row.curation_version,
    sourceRecordIds: parseJson(row.source_record_ids_json, []),
    ...(includeCases ? { cases: parseJson(row.cases_json, []) } : {}),
    suiteFingerprint: row.suite_fingerprint,
    createdAt: row.created_at,
  }
}

function runView(row, { includeDetails = false } = {}) {
  return {
    id: row.id,
    state: 'completed',
    suiteId: row.suite_id,
    candidateId: row.candidate_id,
    baselineSha256: row.baseline_sha256,
    candidateSha256: row.candidate_sha256,
    providerId: row.model_provider_id || null,
    modelName: row.model_name,
    ...(row.model_config_revision != null ? { configRevision: row.model_config_revision } : {}),
    parameters: { temperature: row.temperature, maxTokens: row.max_tokens },
    isolationMode: row.isolation_mode,
    runFingerprint: row.run_fingerprint,
    createdAt: row.created_at,
    ...(includeDetails ? {
      baselineContent: row.baseline_content,
      results: parseJson(row.results_json, []),
    } : {}),
  }
}

export function evolutionReplayFingerprintResults(results = []) {
  const stripCost = (value) => {
    if (!value || typeof value !== 'object') return value
    const result = { ...value }
    delete result.costUsd
    return result
  }
  return (Array.isArray(results) ? results : []).map((result) => ({
    ...result,
    ...(Object.hasOwn(result || {}, 'baseline') ? { baseline: stripCost(result.baseline) } : {}),
    ...(Object.hasOwn(result || {}, 'candidate') ? { candidate: stripCost(result.candidate) } : {}),
  }))
}

function normalizeSuiteCases(casesValue, dataset) {
  if (!Array.isArray(casesValue) || casesValue.length < 1 || casesValue.length > MAX_CASES) {
    throw serviceError('EVOLUTION_REPLAY_CASES_INVALID', `cases must contain between 1 and ${MAX_CASES} entries`)
  }
  const records = new Map(dataset.records.map((record) => [record.id, record]))
  const seen = new Set()
  return casesValue.map((entry) => {
    const sourceRecordId = String(entry?.sourceRecordId || '').trim()
    if (!records.has(sourceRecordId)) {
      throw serviceError('EVOLUTION_SOURCE_RECORD_NOT_FOUND', 'a replay source record was not found', 404)
    }
    const title = inputText(entry?.title, 160, 'EVOLUTION_REPLAY_CASE_INVALID', 'case title')
    const input = inputText(entry?.input, 4_000, 'EVOLUTION_REPLAY_CASE_INVALID', 'case input')
    const fingerprint = sha256({ sourceRecordId, title, input })
    if (seen.has(fingerprint)) throw serviceError('EVOLUTION_REPLAY_CASE_DUPLICATE', 'replay cases must be unique')
    seen.add(fingerprint)
    return {
      id: `case:${fingerprint.slice(0, 24)}`,
      sourceRecordId,
      title,
      input,
      caseFingerprint: fingerprint,
    }
  })
}

export function createEvolutionReplaySuite({
  userId,
  name,
  datasetFingerprint,
  cases,
  now = Date.now(),
} = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  const normalizedName = inputText(name, 160, 'EVOLUTION_REPLAY_SUITE_NAME_INVALID', 'name')
  const expectedFingerprint = String(datasetFingerprint || '').trim().toLowerCase()
  if (!SHA256_RE.test(expectedFingerprint)) {
    throw serviceError('EVOLUTION_DATASET_FINGERPRINT_INVALID', 'datasetFingerprint must be a SHA-256 digest')
  }
  const dataset = buildEvolutionDataset({ userId: owner, limit: 200 })
  if (dataset.datasetFingerprint !== expectedFingerprint) {
    throw serviceError('EVOLUTION_DATASET_STALE', 'curated dataset fingerprint is stale', 409)
  }
  const normalizedCases = normalizeSuiteCases(cases, dataset)
  const sourceRecordIds = [...new Set(normalizedCases.map((entry) => entry.sourceRecordId))].sort()
  const suiteFingerprint = sha256({
    datasetFingerprint: expectedFingerprint,
    curationVersion: dataset.curationVersion,
    cases: normalizedCases,
  })
  const id = randomUUID()
  const createdAt = timestamp(now)
  getDb().prepare(`
    INSERT INTO evolution_replay_suites (
      id, user_id, name, dataset_fingerprint, curation_version,
      source_record_ids_json, cases_json, suite_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    owner,
    normalizedName,
    expectedFingerprint,
    dataset.curationVersion,
    JSON.stringify(sourceRecordIds),
    JSON.stringify(normalizedCases),
    suiteFingerprint,
    createdAt,
  )
  return getEvolutionReplaySuite({ userId: owner, id })
}

export function getEvolutionReplaySuite({ userId, id } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  const row = getDb().prepare('SELECT * FROM evolution_replay_suites WHERE id = ? AND user_id = ?')
    .get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_REPLAY_SUITE_NOT_FOUND', 'replay suite was not found', 404)
  return suiteView(row, { includeCases: true })
}

export function listEvolutionReplaySuites({ userId, limit } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return getDb().prepare(`
    SELECT * FROM evolution_replay_suites WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => suiteView(row))
}

function replayParameters(value = {}) {
  const temperature = value.temperature == null ? 0 : Number(value.temperature)
  const maxTokens = value.maxTokens == null ? 1_024 : Number(value.maxTokens)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw serviceError('EVOLUTION_REPLAY_PARAMETERS_INVALID', 'temperature must be between 0 and 2')
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4_096) {
    throw serviceError('EVOLUTION_REPLAY_PARAMETERS_INVALID', 'maxTokens must be between 1 and 4096')
  }
  return { temperature, maxTokens }
}

function replayMessages(systemContent, replayCase) {
  return [
    {
      role: 'system',
      content: 'Isolated replay: answer the case using the following proposed system instructions. No tools are available. Never claim to access files, networks, services, or runtime state.',
    },
    { role: 'system', content: systemContent },
    { role: 'user', content: replayCase.input },
  ]
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') return null
  const keys = ['promptTokens', 'completionTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens']
  const usage = Object.fromEntries(keys.map((key) => {
    const number = Number(value[key])
    return [key, Number.isFinite(number) && number >= 0 ? number : 0]
  }))
  if (!keys.some((key) => Number.isFinite(Number(value[key])))) return null
  return usage
}

async function replayOne({ runModel, userId, providerId, runtimeProviderId, runtimeEnv, configRevision, modelName, parameters, systemContent, replayCase, signal }) {
  const startedAt = Date.now()
  const response = await runModel({
    messages: replayMessages(systemContent, replayCase),
    userId,
    providerId,
    runtimeProviderId,
    runtimeEnv,
    configRevision,
    modelName,
    parameters,
    signal,
  })
  const actualModel = String(response?.modelName || '').trim()
  const actualProvider = String(response?.providerId || '').trim()
  if (actualProvider !== providerId || actualModel !== modelName) {
    throw serviceError('EVOLUTION_REPLAY_MODEL_MISMATCH', 'replay did not use the fixed Provider and model', 502)
  }
  const raw = String(response?.content ?? response ?? '').trim()
  if (!raw || raw.length > 12_000) {
    throw serviceError('EVOLUTION_REPLAY_OUTPUT_INVALID', 'replay output is empty or too large', 502)
  }
  const usage = normalizedUsage(response?.usage)
  const cost = normalizeOptionalUsageNumber(response?.costUsd)
  return {
    output: sanitizeEvolutionText(raw),
    durationMs: Math.max(0, Date.now() - startedAt),
    usage,
    costUsd: usage && cost !== null ? cost : null,
  }
}

export async function runEvolutionReplay({
  userId,
  suiteId,
  candidateId,
  baselineContent,
  providerId,
  modelName,
  parameters: parametersValue,
  idempotencyKey,
  operationId,
  now = Date.now(),
  signal,
  runModel = ({ messages, userId: owner, providerId: fixedProvider, runtimeProviderId, runtimeEnv, modelName: fixedModel, parameters, signal: abortSignal }) => (
    callEvolutionBackgroundModel({
      messages,
      userId: owner,
      providerId: fixedProvider,
      runtimeProviderId,
      modelName: fixedModel,
      signal: abortSignal,
      runtimeEnv,
      envOverrides: {
        MODEL_STRICT_SELECTION: '1',
        MODEL_FAILOVER_CROSS_MODEL: '0',
        MODEL_TEMPERATURE: String(parameters.temperature),
        MODEL_MAX_TOKENS: String(parameters.maxTokens),
      },
    })
  ),
} = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  const suite = getEvolutionReplaySuite({ userId: owner, id: suiteId })
  const candidate = getEvolutionCandidate({ userId: owner, id: candidateId })
  if (candidate.kind !== 'prompt') {
    throw serviceError('EVOLUTION_REPLAY_KIND_UNSUPPORTED', 'only prompt candidates can be replayed safely', 409)
  }
  if (candidate.provenance.datasetFingerprint !== suite.datasetFingerprint) {
    throw serviceError('EVOLUTION_REPLAY_PROVENANCE_MISMATCH', 'candidate and replay suite use different datasets', 409)
  }
  const baseline = inputText(
    baselineContent,
    24_000,
    'EVOLUTION_REPLAY_BASELINE_INVALID',
    'baselineContent',
  )
  const fixedProvider = inputText(providerId, 512, 'EVOLUTION_REPLAY_PROVIDER_INVALID', 'providerId')
  const fixedModel = inputText(modelName, 512, 'EVOLUTION_REPLAY_MODEL_INVALID', 'modelName')
  const modelIdentity = resolveEvolutionModelIdentity({
    userId: owner,
    providerId: fixedProvider,
    modelName: fixedModel,
  })
  const durableProvider = modelIdentity.providerId
  const parameters = replayParameters(parametersValue)
  const createdAt = timestamp(now)
  let operation = openEvolutionOperation({
    userId: owner,
    kind: 'replay',
    idempotencyKey,
    operationId,
    request: {
      suiteId: suite.id,
      suiteFingerprint: suite.suiteFingerprint,
      candidateId: candidate.id,
      candidateSha256: candidate.contentSha256,
      baselineContent: baseline,
      providerId: durableProvider,
      modelName: fixedModel,
      configRevision: modelIdentity.configRevision,
      parameters,
    },
    now: createdAt,
  })
  if (operation.state === 'completed') {
    return getEvolutionReplayRun({ userId: owner, id: operation.result.id })
  }
  assertEvolutionOperationRunnable(operation)

  const storedResults = Array.isArray(operation.checkpoint?.results)
    ? operation.checkpoint.results
    : []
  const results = storedResults.map((result) => ({ ...result }))
  let resultId = operation.checkpoint?.resultId || randomUUID()
  for (let caseIndex = 0; caseIndex < suite.cases.length; caseIndex += 1) {
    const replayCase = suite.cases[caseIndex]
    let result = results[caseIndex]
    if (result && result.caseId !== replayCase.id) {
      throw serviceError('EVOLUTION_REPLAY_CHECKPOINT_INVALID', 'replay checkpoint case identity changed', 409)
    }
    if (!result) {
      result = { caseId: replayCase.id }
      results[caseIndex] = result
    }

    for (const side of ['baseline', 'candidate']) {
      if (result[side]) continue
      const modelClaim = claimEvolutionOperation({
        userId: owner,
        id: operation.id,
        stage: `replay:case:${caseIndex}:${side}:model_call`,
      })
      const modelLease = holdEvolutionOperationLease({
        userId: owner,
        id: operation.id,
        workerToken: modelClaim.workerToken,
        leaseOwnerId: modelClaim.leaseOwnerId,
        leaseExpiresAt: modelClaim.leaseExpiresAt,
        signal,
      })
      let sideResult
      try {
        sideResult = await replayOne({
          runModel,
          userId: owner,
          providerId: durableProvider,
          runtimeProviderId: modelIdentity.runtimeProviderId,
          runtimeEnv: modelIdentity.runtimeEnv,
          configRevision: modelIdentity.configRevision,
          modelName: fixedModel,
          parameters,
          systemContent: side === 'baseline' ? baseline : candidate.content,
          replayCase,
          signal: modelLease.signal,
        })
      } catch (error) {
        const failure = error?.name === 'AbortError' || error?.code
          ? error
          : serviceError('EVOLUTION_REPLAY_MODEL_FAILED', 'isolated replay model call failed', 502)
        try {
          blockEvolutionOperation({
            userId: owner,
            id: operation.id,
            workerToken: modelClaim.workerToken,
            leaseOwnerId: modelClaim.leaseOwnerId,
            error: failure,
          })
        } finally {
          modelLease.stop()
        }
        throw attachEvolutionOperationError(failure, operation.id)
      }
      try {
        result[side] = sideResult
        const nextSide = side === 'baseline' ? 'candidate' : 'baseline'
        const nextCaseIndex = side === 'baseline' ? caseIndex : caseIndex + 1
        operation = checkpointEvolutionOperation({
          userId: owner,
          id: operation.id,
          workerToken: modelClaim.workerToken,
          leaseOwnerId: modelClaim.leaseOwnerId,
          stage: `replay:case:${caseIndex}:${side}:checkpointed`,
          checkpoint: {
            resultId,
            results,
            nextCaseIndex,
            nextSide,
            progress: {
              completedCalls: (caseIndex * 2) + (side === 'baseline' ? 1 : 2),
              totalCalls: suite.cases.length * 2,
              nextCaseIndex,
              nextSide,
            },
          },
        })
      } catch (error) {
        try {
          if (error?.code !== 'EVOLUTION_OPERATION_IN_PROGRESS') {
            failEvolutionOperation({
              userId: owner,
              id: operation.id,
              workerToken: modelClaim.workerToken,
              leaseOwnerId: modelClaim.leaseOwnerId,
              error,
            })
          }
        } finally {
          modelLease.stop()
        }
        throw attachEvolutionOperationError(error, operation.id)
      }
      modelLease.stop()
    }
  }

  const baselineSha256 = sha256(baseline)
  const runFingerprint = sha256({
    suiteFingerprint: suite.suiteFingerprint,
    candidateSha256: candidate.contentSha256,
    baselineSha256,
    providerId: durableProvider,
    configRevision: modelIdentity.configRevision,
    modelName: fixedModel,
    parameters,
    isolationMode: 'model_no_tools',
    results: evolutionReplayFingerprintResults(results),
  })
  const finalClaim = claimEvolutionOperation({
    userId: owner,
    id: operation.id,
    stage: 'replay:finalizing',
  })
  try {
    assertEvolutionModelIdentityCurrent({ userId: owner, identity: modelIdentity })
    commitEvolutionOperation({
      userId: owner,
      id: operation.id,
      workerToken: finalClaim.workerToken,
      leaseOwnerId: finalClaim.leaseOwnerId,
      resultType: 'replay',
      resultId,
      checkpoint: operation.checkpoint,
      writeResult: (db) => db.prepare(`
        INSERT INTO evolution_replay_runs (
          id, user_id, suite_id, candidate_id, baseline_content, baseline_sha256,
          candidate_sha256, model_provider_id, model_name, model_config_revision, temperature, max_tokens, isolation_mode,
          results_json, run_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model_no_tools', ?, ?, ?)
      `).run(
        resultId, owner, suite.id, candidate.id, baseline, baselineSha256,
        candidate.contentSha256, durableProvider, fixedModel, modelIdentity.configRevision,
        parameters.temperature, parameters.maxTokens,
        JSON.stringify(results), runFingerprint, createdAt,
      ),
    })
  } catch (error) {
    if (error?.code !== 'EVOLUTION_OPERATION_IN_PROGRESS') {
      try {
        failEvolutionOperation({
          userId: owner,
          id: operation.id,
          workerToken: finalClaim.workerToken,
          leaseOwnerId: finalClaim.leaseOwnerId,
          error,
        })
      } catch {
        // A fenced completion already exposes the authoritative operation state.
      }
    }
    throw attachEvolutionOperationError(error, operation.id)
  }
  return getEvolutionReplayRun({ userId: owner, id: resultId })
}

export function getEvolutionReplayRun({ userId, id } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  const row = getDb().prepare('SELECT * FROM evolution_replay_runs WHERE id = ? AND user_id = ?')
    .get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_REPLAY_NOT_FOUND', 'replay run was not found', 404)
  return runView(row, { includeDetails: true })
}

export function listEvolutionReplayRuns({ userId, limit } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return getDb().prepare(`
    SELECT * FROM evolution_replay_runs WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => runView(row))
}

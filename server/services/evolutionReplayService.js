import { createHash, randomUUID } from 'node:crypto'

import { callBackgroundModelWithTools, getRuntimeEnv } from '../adapters/modelProxy.js'
import { getDb } from '../db.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { buildEvolutionDataset, sanitizeEvolutionText } from './evolutionDatasetService.js'

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
    modelName: row.model_name,
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

async function replayOne({ runModel, userId, modelName, parameters, systemContent, replayCase, signal }) {
  const startedAt = Date.now()
  const response = await runModel({
    messages: replayMessages(systemContent, replayCase),
    userId,
    modelName,
    parameters,
    signal,
  })
  const actualModel = String(response?.modelName || '').trim()
  if (!actualModel || actualModel !== modelName) {
    throw serviceError('EVOLUTION_REPLAY_MODEL_MISMATCH', 'replay did not use the fixed model', 502)
  }
  const raw = String(response?.content ?? response ?? '').trim()
  if (!raw || raw.length > 12_000) {
    throw serviceError('EVOLUTION_REPLAY_OUTPUT_INVALID', 'replay output is empty or too large', 502)
  }
  const usage = normalizedUsage(response?.usage)
  const cost = Number(response?.costUsd)
  return {
    output: sanitizeEvolutionText(raw),
    durationMs: Math.max(0, Date.now() - startedAt),
    usage,
    costUsd: usage && Number.isFinite(cost) && cost >= 0 ? cost : null,
  }
}

export async function runEvolutionReplay({
  userId,
  suiteId,
  candidateId,
  baselineContent,
  modelName,
  parameters: parametersValue,
  now = Date.now(),
  signal,
  runModel = ({ messages, userId: owner, modelName: fixedModel, parameters, signal: abortSignal }) => (
    callBackgroundModelWithTools({
      messages,
      userId: owner,
      modelName: fixedModel,
      signal: abortSignal,
      env: {
        ...getRuntimeEnv(),
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
  const fixedModel = inputText(modelName, 512, 'EVOLUTION_REPLAY_MODEL_INVALID', 'modelName')
  const parameters = replayParameters(parametersValue)
  const createdAt = timestamp(now)
  const results = []
  try {
    for (const replayCase of suite.cases) {
      const baselineResult = await replayOne({
        runModel, userId: owner, modelName: fixedModel, parameters,
        systemContent: baseline, replayCase, signal,
      })
      const candidateResult = await replayOne({
        runModel, userId: owner, modelName: fixedModel, parameters,
        systemContent: candidate.content, replayCase, signal,
      })
      results.push({ caseId: replayCase.id, baseline: baselineResult, candidate: candidateResult })
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code) throw error
    throw serviceError('EVOLUTION_REPLAY_MODEL_FAILED', 'isolated replay model call failed', 502)
  }
  const baselineSha256 = sha256(baseline)
  const runFingerprint = sha256({
    suiteFingerprint: suite.suiteFingerprint,
    candidateSha256: candidate.contentSha256,
    baselineSha256,
    modelName: fixedModel,
    parameters,
    isolationMode: 'model_no_tools',
    results,
  })
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO evolution_replay_runs (
      id, user_id, suite_id, candidate_id, baseline_content, baseline_sha256,
      candidate_sha256, model_name, temperature, max_tokens, isolation_mode,
      results_json, run_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model_no_tools', ?, ?, ?)
  `).run(
    id, owner, suite.id, candidate.id, baseline, baselineSha256,
    candidate.contentSha256, fixedModel, parameters.temperature, parameters.maxTokens,
    JSON.stringify(results), runFingerprint, createdAt,
  )
  return getEvolutionReplayRun({ userId: owner, id })
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

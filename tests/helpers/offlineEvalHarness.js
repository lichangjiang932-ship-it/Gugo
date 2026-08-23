import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  OFFLINE_EVAL_OPTIONS_ENV,
  OFFLINE_EVAL_REPORT_KIND,
  OFFLINE_EVAL_REPORT_SCHEMA_VERSION,
  validateOfflineEvalReport,
} from '../../scripts/offlineEvalCli.js'

const DEFAULT_SUITE_DIRECTORY = fileURLToPath(new URL('../offline-evals/', import.meta.url))
const SUITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_DIAGNOSTIC_LENGTH = 2_000
const SENSITIVE_DIAGNOSTIC_KEY_SUFFIXES = Object.freeze([
  'apikey',
  'token',
  'password',
  'passwd',
  'secret',
  'authorization',
  'privatekey',
  'credential',
  'credentials',
])
export const DEFAULT_OFFLINE_EVAL_CASE_TIMEOUT_MS = 5_000
export const OFFLINE_EVAL_TEST_TIMEOUT_GRACE_MS = 2_000
const OFFLINE_EVAL_CLEANUP_TIMEOUT_MS = 1_000

class OfflineEvalDefinitionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OfflineEvalDefinitionError'
    this.code = 'OFFLINE_EVAL_DEFINITION_INVALID'
  }
}

function definitionError(message) {
  throw new OfflineEvalDefinitionError(message)
}

function requiredText(value, label, pattern = null) {
  const text = String(value || '').trim()
  if (!text) definitionError(`${label} is required`)
  if (pattern && !pattern.test(text)) definitionError(`${label} is invalid: ${text}`)
  return text
}

function isSensitiveDiagnosticKey(key) {
  const normalized = String(key || '').replace(/[^a-z0-9]/giu, '').toLowerCase()
  return SENSITIVE_DIAGNOSTIC_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

function stringifyDiagnostic(value) {
  const seen = new WeakSet()
  return JSON.stringify(value, (key, nestedValue) => {
    if (key && isSensitiveDiagnosticKey(key)) return '[REDACTED]'
    if (nestedValue && typeof nestedValue === 'object') {
      if (seen.has(nestedValue)) return '[Circular]'
      seen.add(nestedValue)
    }
    return nestedValue
  })
}

function sanitizeText(value) {
  let text
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = stringifyDiagnostic(value)
    } catch {
      text = String(value)
    }
  }
  return String(text || '')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(
      /((?:"?(?:api[_-]?key|token|password|passwd|secret|authorization)"?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|[^\s,;}]+)/giu,
      '$1"[REDACTED]"',
    )
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^:@/\s]+:[^@/\s]+@/giu, '$1[REDACTED]@')
    .slice(0, MAX_DIAGNOSTIC_LENGTH)
}

function errorDiagnostic(error) {
  const code = error?.code ? `[${sanitizeText(error.code)}] ` : ''
  return sanitizeText(`${code}${error?.message || error || 'unknown offline eval failure'}`)
}

export function defineOfflineEvalCase({ id, category, title, run, timeoutMs = null } = {}) {
  const normalizedId = requiredText(id, 'offline eval case id', CASE_ID_PATTERN)
  const normalizedCategory = requiredText(category, `offline eval case ${normalizedId} category`)
  const normalizedTitle = requiredText(title, `offline eval case ${normalizedId} title`)
  if (typeof run !== 'function') definitionError(`offline eval case ${normalizedId} requires run()`)
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    definitionError(`offline eval case ${normalizedId} timeoutMs must be a positive integer`)
  }
  return Object.freeze({
    id: normalizedId,
    category: normalizedCategory,
    title: normalizedTitle,
    run,
    timeoutMs,
  })
}

export function defineOfflineEvalSuite({ id, title, version, cases } = {}) {
  const normalizedId = requiredText(id, 'offline eval suite id', SUITE_ID_PATTERN)
  const normalizedTitle = requiredText(title, `offline eval suite ${normalizedId} title`)
  if (!Number.isInteger(version) || version <= 0) {
    definitionError(`offline eval suite ${normalizedId} version must be a positive integer`)
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    definitionError(`offline eval suite ${normalizedId} requires at least one case`)
  }
  const normalizedCases = cases.map((evalCase) => {
    if (!evalCase || typeof evalCase !== 'object' || Array.isArray(evalCase)) {
      definitionError(`offline eval suite ${normalizedId} contains an invalid case`)
    }
    return defineOfflineEvalCase(evalCase)
  })
  const ids = new Set()
  for (const evalCase of normalizedCases) {
    if (ids.has(evalCase.id)) {
      definitionError(`offline eval suite ${normalizedId} has duplicate case id: ${evalCase.id}`)
    }
    ids.add(evalCase.id)
  }
  return Object.freeze({
    id: normalizedId,
    title: normalizedTitle,
    version,
    cases: Object.freeze([...normalizedCases]),
  })
}

export function parseOfflineEvalOptions(raw = process.env[OFFLINE_EVAL_OPTIONS_ENV]) {
  if (!String(raw || '').trim()) {
    return Object.freeze({ suiteIds: Object.freeze([]), baselinePath: null, reportPath: null })
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new OfflineEvalDefinitionError(
      `${OFFLINE_EVAL_OPTIONS_ENV} must contain valid JSON: ${error?.message || error}`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    definitionError(`${OFFLINE_EVAL_OPTIONS_ENV} must contain an object`)
  }
  if (parsed.suiteIds !== undefined && !Array.isArray(parsed.suiteIds)) {
    definitionError('offline eval suiteIds must be an array')
  }
  const suiteIds = (parsed.suiteIds || [])
    .map((id) => requiredText(id, 'offline eval suite selector', SUITE_ID_PATTERN))
  if (new Set(suiteIds).size !== suiteIds.length) {
    definitionError('offline eval suite selectors must be unique')
  }
  return Object.freeze({
    suiteIds: Object.freeze(suiteIds),
    baselinePath: parsed.baselinePath ? String(parsed.baselinePath) : null,
    reportPath: parsed.reportPath ? String(parsed.reportPath) : null,
  })
}

export async function discoverOfflineEvalSuites({
  directory = DEFAULT_SUITE_DIRECTORY,
  loadModule = async (filePath) => import(pathToFileURL(filePath).href),
} = {}) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.eval.js'))
    .sort((left, right) => left.name.localeCompare(right.name))
  const suites = []
  const ids = new Set()
  for (const entry of entries) {
    const module = await loadModule(join(directory, entry.name))
    const suite = module?.default
    if (!suite || !Array.isArray(suite.cases)) {
      definitionError(`offline eval module ${entry.name} must default-export a suite`)
    }
    if (ids.has(suite.id)) definitionError(`duplicate offline eval suite id: ${suite.id}`)
    ids.add(suite.id)
    suites.push(suite)
  }
  return Object.freeze(suites.sort((left, right) => left.id.localeCompare(right.id)))
}

function createCaseContext(signal) {
  const cleanups = []
  const diagnostics = []
  const metrics = new Map()
  const context = Object.freeze({
    signal,
    defer(cleanup) {
      if (typeof cleanup !== 'function') definitionError('offline eval defer requires a function')
      cleanups.push(cleanup)
    },
    diagnostic(value) {
      diagnostics.push(sanitizeText(value))
    },
    metric(name, value) {
      const metricName = requiredText(name, 'offline eval metric name')
      if (!Number.isFinite(value)) definitionError(`offline eval metric ${metricName} must be finite`)
      metrics.set(metricName, value)
    },
  })
  return { context, cleanups, diagnostics, metrics }
}

async function settleWithin(promise, timeoutMs) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', error }),
      ),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ status: 'timeout' }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function failedOutcome(suite, evalCase, error, durationMs = 0) {
  return {
    suiteId: suite.id,
    id: evalCase.id,
    category: evalCase.category,
    title: evalCase.title,
    status: 'failed',
    durationMs,
    metrics: {},
    diagnostics: [errorDiagnostic(error)],
  }
}

export async function executeOfflineEvalCase(suite, evalCase) {
  const startedAt = Date.now()
  const abortController = new AbortController()
  const state = createCaseContext(abortController.signal)
  let failure = null
  const timeoutMs = evalCase.timeoutMs || DEFAULT_OFFLINE_EVAL_CASE_TIMEOUT_MS
  const execution = await settleWithin(
    Promise.resolve().then(() => evalCase.run(state.context)),
    timeoutMs,
  )
  if (execution.status === 'timeout') {
    abortController.abort(new Error(`offline eval case exceeded ${timeoutMs}ms`))
    failure = new Error(`offline eval case exceeded ${timeoutMs}ms`)
    failure.code = 'OFFLINE_EVAL_CASE_TIMEOUT'
  } else if (execution.status === 'rejected') {
    failure = execution.error
  }

  while (state.cleanups.length) {
    const cleanup = state.cleanups.pop()
    const cleanupResult = await settleWithin(
      Promise.resolve().then(() => cleanup()),
      OFFLINE_EVAL_CLEANUP_TIMEOUT_MS,
    )
    if (cleanupResult.status === 'timeout') {
      const error = new Error(
        `offline eval cleanup exceeded ${OFFLINE_EVAL_CLEANUP_TIMEOUT_MS}ms`,
      )
      error.code = 'OFFLINE_EVAL_CLEANUP_TIMEOUT'
      state.diagnostics.push(`cleanup failed: ${errorDiagnostic(error)}`)
      if (!failure) failure = error
    } else if (cleanupResult.status === 'rejected') {
      state.diagnostics.push(`cleanup failed: ${errorDiagnostic(cleanupResult.error)}`)
      if (!failure) failure = cleanupResult.error
    }
  }

  if (failure) state.diagnostics.unshift(errorDiagnostic(failure))
  const metrics = Object.fromEntries([...state.metrics.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  )))
  return {
    suiteId: suite.id,
    id: evalCase.id,
    category: evalCase.category,
    title: evalCase.title,
    status: failure ? 'failed' : 'passed',
    durationMs: Math.max(0, Date.now() - startedAt),
    metrics,
    diagnostics: state.diagnostics,
  }
}

export function createOfflineEvalFailureReport(error, { selectedSuiteIds = [] } = {}) {
  const failureCase = {
    suiteId: 'harness',
    id: 'HARNESS',
    category: 'harness',
    title: 'Offline eval harness failure',
    status: 'failed',
    durationMs: 0,
    metrics: {},
    diagnostics: [errorDiagnostic(error)],
  }
  return {
    kind: OFFLINE_EVAL_REPORT_KIND,
    schemaVersion: OFFLINE_EVAL_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    harnessFailure: true,
    selection: {
      mode: selectedSuiteIds.length ? 'filtered' : 'all',
      suiteIds: [...selectedSuiteIds].sort(),
    },
    suites: [{
      id: 'harness',
      title: 'Offline eval harness',
      version: 1,
      cases: [failureCase],
    }],
    summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
  }
}

export function attachOfflineEvalNetworkAttempts(report, attempts = []) {
  const normalizedAttempts = (Array.isArray(attempts) ? attempts : []).map((attempt) => ({
    sequence: Number.isInteger(attempt?.sequence) ? attempt.sequence : null,
    transport: sanitizeText(attempt?.transport || 'unknown'),
    target: sanitizeText(attempt?.target || '[unknown-target]'),
  }))
  if (!normalizedAttempts.length) return { ...report, networkAttempts: [] }

  const suites = report.suites.map((suite) => ({ ...suite, cases: [...suite.cases] }))
  let harnessSuite = suites.find((suite) => suite.id === 'harness')
  if (!harnessSuite) {
    harnessSuite = {
      id: 'harness',
      title: 'Offline eval harness',
      version: 1,
      cases: [],
    }
    suites.push(harnessSuite)
  }
  harnessSuite.cases.push({
    suiteId: 'harness',
    id: 'NETWORK',
    category: 'network',
    title: 'Offline eval attempted network access',
    status: 'failed',
    durationMs: 0,
    metrics: { attempts: normalizedAttempts.length },
    diagnostics: [
      `offline eval blocked ${normalizedAttempts.length} network attempt(s): ${JSON.stringify(normalizedAttempts)}`,
    ],
  })
  suites.sort((left, right) => left.id.localeCompare(right.id))
  return {
    ...report,
    networkAttempts: normalizedAttempts,
    suites,
    summary: summarize(suites),
  }
}

function summarize(suites) {
  const cases = suites.flatMap((suite) => suite.cases)
  return {
    total: cases.length,
    passed: cases.filter((entry) => entry.status === 'passed').length,
    failed: cases.filter((entry) => entry.status === 'failed').length,
    skipped: cases.filter((entry) => entry.status === 'skipped').length,
  }
}

export async function runOfflineEvalSuites({
  suites,
  selectedSuiteIds = [],
  runCase = async ({ execute }) => execute(),
} = {}) {
  if (!Array.isArray(suites)) definitionError('offline eval suites must be an array')
  if (typeof runCase !== 'function') definitionError('offline eval runCase must be a function')
  const suiteById = new Map()
  for (const suite of suites) {
    if (suiteById.has(suite.id)) definitionError(`duplicate offline eval suite id: ${suite.id}`)
    suiteById.set(suite.id, suite)
  }
  const selectedIds = selectedSuiteIds.length
    ? [...selectedSuiteIds]
    : [...suiteById.keys()]
  for (const suiteId of selectedIds) {
    if (!suiteById.has(suiteId)) definitionError(`unknown offline eval suite: ${suiteId}`)
  }

  const suiteReports = []
  for (const suiteId of selectedIds.sort()) {
    const suite = suiteById.get(suiteId)
    const caseReports = []
    for (const evalCase of suite.cases) {
      let execution = null
      const execute = async () => {
        if (!execution) execution = executeOfflineEvalCase(suite, evalCase)
        return execution
      }
      try {
        const returned = await runCase({ suite, evalCase, execute })
        caseReports.push(returned || execution || failedOutcome(
          suite,
          evalCase,
          new Error('offline eval runner did not execute the case'),
        ))
      } catch (error) {
        const existing = execution ? await execution : null
        if (existing?.status === 'failed') {
          caseReports.push(existing)
        } else {
          caseReports.push(failedOutcome(suite, evalCase, error, existing?.durationMs || 0))
        }
      }
    }
    suiteReports.push({
      id: suite.id,
      title: suite.title,
      version: suite.version,
      cases: caseReports,
    })
  }

  return {
    kind: OFFLINE_EVAL_REPORT_KIND,
    schemaVersion: OFFLINE_EVAL_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    selection: {
      mode: selectedSuiteIds.length ? 'filtered' : 'all',
      suiteIds: [...selectedIds].sort(),
    },
    suites: suiteReports,
    summary: summarize(suiteReports),
  }
}

function incompatibleBaseline(report, message) {
  return {
    ...report,
    baseline: {
      compared: true,
      compatible: false,
      incompatibilities: [sanitizeText(message)],
      regressions: [],
      missingCases: [],
      newCases: [],
    },
  }
}

export async function compareOfflineEvalBaseline(report, baselinePath) {
  let baseline
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  } catch (error) {
    return incompatibleBaseline(report, `unable to read baseline: ${error?.message || error}`)
  }
  if (baseline?.kind !== OFFLINE_EVAL_REPORT_KIND
    || baseline?.schemaVersion !== OFFLINE_EVAL_REPORT_SCHEMA_VERSION
    || !Array.isArray(baseline?.suites)) {
    return incompatibleBaseline(report, 'baseline kind or schema is incompatible')
  }

  const baselineSuites = new Map(baseline.suites.map((suite) => [suite.id, suite]))
  const comparison = {
    compared: true,
    compatible: true,
    incompatibilities: [],
    regressions: [],
    missingCases: [],
    newCases: [],
  }
  for (const suite of report.suites) {
    const previousSuite = baselineSuites.get(suite.id)
    if (!previousSuite) {
      comparison.newCases.push(...suite.cases.map((evalCase) => ({
        suiteId: suite.id,
        caseId: evalCase.id,
      })))
      continue
    }
    if (previousSuite.version !== suite.version) {
      comparison.compatible = false
      comparison.incompatibilities.push({
        suiteId: suite.id,
        baselineVersion: previousSuite.version,
        currentVersion: suite.version,
      })
      continue
    }
    const currentCases = new Map(suite.cases.map((evalCase) => [evalCase.id, evalCase]))
    const previousCases = new Map((previousSuite.cases || []).map((evalCase) => [
      evalCase.id,
      evalCase,
    ]))
    for (const [caseId, previousCase] of previousCases) {
      const currentCase = currentCases.get(caseId)
      if (!currentCase) {
        comparison.missingCases.push({ suiteId: suite.id, caseId })
      } else if (previousCase.status === 'passed' && currentCase.status !== 'passed') {
        comparison.regressions.push({
          suiteId: suite.id,
          caseId,
          baselineStatus: previousCase.status,
          currentStatus: currentCase.status,
        })
      }
    }
    for (const caseId of currentCases.keys()) {
      if (!previousCases.has(caseId)) comparison.newCases.push({ suiteId: suite.id, caseId })
    }
  }
  if (report.selection?.mode === 'all') {
    const currentSuiteIds = new Set(report.suites.map((suite) => suite.id))
    for (const previousSuite of baseline.suites) {
      if (currentSuiteIds.has(previousSuite.id)) continue
      for (const previousCase of previousSuite.cases || []) {
        comparison.missingCases.push({
          suiteId: previousSuite.id,
          caseId: previousCase.id,
        })
      }
    }
  }
  return { ...report, baseline: comparison }
}

export async function writeOfflineEvalReport(reportPath, report) {
  validateOfflineEvalReport(report)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

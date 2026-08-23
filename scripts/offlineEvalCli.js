import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'

export const OFFLINE_EVAL_REPORT_KIND = 'gugo.offline-eval-report'
export const OFFLINE_EVAL_REPORT_SCHEMA_VERSION = 1
export const OFFLINE_EVAL_OPTIONS_ENV = 'YMA_OFFLINE_EVAL_OPTIONS'

const EVAL_FLAGS = new Map([
  ['--eval-suite', 'suiteIds'],
  ['--eval-json', 'jsonPath'],
  ['--eval-baseline', 'baselinePath'],
])

export class OfflineEvalUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OfflineEvalUsageError'
    this.code = 'OFFLINE_EVAL_USAGE'
    this.exitCode = 2
  }
}

function usageError(message) {
  throw new OfflineEvalUsageError(message)
}

function optionValue(rawArgs, index, inlineValue, flag) {
  const hasInlineValue = inlineValue !== undefined
  const value = hasInlineValue ? inlineValue : rawArgs[index + 1]
  if (typeof value !== 'string' || !value.trim() || (!hasInlineValue && value.startsWith('--'))) {
    usageError(`${flag} requires a non-empty value`)
  }
  return { value: value.trim(), consumedNext: !hasInlineValue }
}

export function parseOfflineEvalArgs(rawArgs = []) {
  const options = {
    suiteIds: [],
    jsonPath: null,
    baselinePath: null,
    provided: false,
  }
  const remainingArgs = []

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index]
    if (typeof argument !== 'string' || !argument.startsWith('--eval-')) {
      remainingArgs.push(argument)
      continue
    }

    const equalsIndex = argument.indexOf('=')
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    const key = EVAL_FLAGS.get(flag)
    if (!key) usageError(`unknown offline eval option: ${flag}`)

    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1)
    const parsed = optionValue(rawArgs, index, inlineValue, flag)
    if (parsed.consumedNext) index += 1
    options.provided = true

    if (key === 'suiteIds') {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed.value)) {
        usageError(`${flag} must be a lowercase suite id`)
      }
      if (!options.suiteIds.includes(parsed.value)) options.suiteIds.push(parsed.value)
      continue
    }

    if (options[key] !== null) usageError(`${flag} may only be specified once`)
    options[key] = parsed.value
  }

  return { options, remainingArgs }
}

export function assertOfflineEvalInvocation(remainingArgs, options) {
  const selectors = remainingArgs.filter((argument) => (
    typeof argument === 'string' && !argument.startsWith('-')
  ))
  const offlineMode = selectors.length === 1 && selectors[0] === 'offline-eval'
  if (options.provided && !offlineMode) {
    usageError('offline eval options require the single selector "offline-eval"')
  }
  return offlineMode
}

function canonicalPathIdentity(filePath, platform) {
  let canonicalPath
  try {
    canonicalPath = realpathSync.native(filePath)
  } catch {
    try {
      canonicalPath = join(realpathSync.native(dirname(filePath)), basename(filePath))
    } catch {
      canonicalPath = filePath
    }
  }
  const identity = normalize(canonicalPath)
  return platform === 'win32' ? identity.toLowerCase() : identity
}

function sameExistingFile(leftPath, rightPath) {
  if (!existsSync(leftPath) || !existsSync(rightPath)) return false
  try {
    const left = statSync(leftPath)
    const right = statSync(rightPath)
    return left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

export function resolveOfflineEvalOptions(
  options,
  cwd = process.cwd(),
  platform = process.platform,
) {
  const resolved = {
    suiteIds: [...options.suiteIds],
    jsonPath: options.jsonPath ? resolve(cwd, options.jsonPath) : null,
    baselinePath: options.baselinePath ? resolve(cwd, options.baselinePath) : null,
  }
  if (resolved.jsonPath && resolved.baselinePath && (
    canonicalPathIdentity(resolved.jsonPath, platform)
      === canonicalPathIdentity(resolved.baselinePath, platform)
    || sameExistingFile(resolved.jsonPath, resolved.baselinePath)
  )) {
    usageError('--eval-json cannot overwrite --eval-baseline')
  }
  return resolved
}

function invalidReport(message) {
  const error = new Error(message)
  error.name = 'OfflineEvalReportError'
  error.code = 'OFFLINE_EVAL_REPORT_INVALID'
  return error
}

export function validateOfflineEvalReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw invalidReport('offline eval report must be an object')
  }
  if (report.kind !== OFFLINE_EVAL_REPORT_KIND) {
    throw invalidReport(`offline eval report kind must be ${OFFLINE_EVAL_REPORT_KIND}`)
  }
  if (report.schemaVersion !== OFFLINE_EVAL_REPORT_SCHEMA_VERSION) {
    throw invalidReport(
      `unsupported offline eval report schema: ${String(report.schemaVersion)}`,
    )
  }
  if (!Array.isArray(report.suites) || !report.summary || typeof report.summary !== 'object') {
    throw invalidReport('offline eval report is missing suites or summary')
  }
  const observed = { total: 0, passed: 0, failed: 0, skipped: 0 }
  const suiteIds = new Set()
  for (const suite of report.suites) {
    if (!suite || typeof suite !== 'object' || typeof suite.id !== 'string' || !suite.id) {
      throw invalidReport('offline eval report contains an invalid suite')
    }
    if (suiteIds.has(suite.id)) {
      throw invalidReport(`offline eval report has duplicate suite id: ${suite.id}`)
    }
    suiteIds.add(suite.id)
    if (!Number.isInteger(suite.version) || suite.version <= 0 || !Array.isArray(suite.cases)) {
      throw invalidReport(`offline eval suite ${suite.id} has an invalid version or cases`)
    }
    const caseIds = new Set()
    for (const evalCase of suite.cases) {
      if (!evalCase || typeof evalCase !== 'object'
        || typeof evalCase.id !== 'string' || !evalCase.id) {
        throw invalidReport(`offline eval suite ${suite.id} contains an invalid case`)
      }
      if (caseIds.has(evalCase.id)) {
        throw invalidReport(`offline eval suite ${suite.id} has duplicate case id: ${evalCase.id}`)
      }
      caseIds.add(evalCase.id)
      if (!['passed', 'failed', 'skipped'].includes(evalCase.status)) {
        throw invalidReport(
          `offline eval case ${suite.id}/${evalCase.id} has an invalid status`,
        )
      }
      if (evalCase.suiteId !== undefined && evalCase.suiteId !== suite.id) {
        throw invalidReport(`offline eval case ${suite.id}/${evalCase.id} has a mismatched suite id`)
      }
      observed.total += 1
      observed[evalCase.status] += 1
    }
  }
  for (const field of ['total', 'passed', 'failed', 'skipped']) {
    if (!Number.isInteger(report.summary[field]) || report.summary[field] < 0) {
      throw invalidReport(`offline eval summary.${field} must be a non-negative integer`)
    }
  }
  if (report.summary.total !== (
    report.summary.passed + report.summary.failed + report.summary.skipped
  )) {
    throw invalidReport('offline eval summary counts do not add up')
  }
  for (const field of ['total', 'passed', 'failed', 'skipped']) {
    if (report.summary[field] !== observed[field]) {
      throw invalidReport(`offline eval summary.${field} does not match case outcomes`)
    }
  }
  return report
}

export function readOfflineEvalReport(reportPath) {
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (error) {
    throw invalidReport(`unable to read offline eval report: ${error?.message || error}`)
  }
  return validateOfflineEvalReport(report)
}

export function writeOfflineEvalJson(outputPath, report) {
  validateOfflineEvalReport(report)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function offlineEvalReportFailed(report) {
  if (report.summary.failed > 0) return true
  const baseline = report.baseline
  if (!baseline?.compared) return false
  return baseline.compatible === false
    || (baseline.regressions?.length || 0) > 0
    || (baseline.missingCases?.length || 0) > 0
}

export function offlineEvalFailureMessages(report) {
  const messages = []
  for (const suite of report.suites || []) {
    for (const evalCase of suite.cases || []) {
      if (evalCase.status !== 'failed') continue
      const detail = evalCase.diagnostics?.[0] || 'failed without diagnostics'
      messages.push(`${suite.id}/${evalCase.id}: ${detail}`)
    }
  }
  const baseline = report.baseline
  if (baseline?.compared && baseline.compatible === false) {
    messages.push(`baseline incompatible: ${JSON.stringify(baseline.incompatibilities || [])}`)
  }
  if (baseline?.regressions?.length) {
    messages.push(`baseline regressions: ${JSON.stringify(baseline.regressions)}`)
  }
  if (baseline?.missingCases?.length) {
    messages.push(`baseline missing cases: ${JSON.stringify(baseline.missingCases)}`)
  }
  return messages
}

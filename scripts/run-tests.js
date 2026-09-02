#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { spawn } from 'node:child_process'

import {
  OFFLINE_EVAL_OPTIONS_ENV,
  OfflineEvalUsageError,
  assertOfflineEvalInvocation,
  offlineEvalFailureMessages,
  offlineEvalReportFailed,
  parseOfflineEvalArgs,
  readOfflineEvalReport,
  resolveOfflineEvalOptions,
  writeOfflineEvalJson,
} from './offlineEvalCli.js'
import { sanitizeChildEnv } from '../server/utils/sensitiveEnv.js'

const rawArgs = process.argv.slice(2)
let testArgs
let offlineEvalMode
let offlineEvalOptions
try {
  const parsed = parseOfflineEvalArgs(rawArgs)
  testArgs = parsed.remainingArgs
  offlineEvalMode = assertOfflineEvalInvocation(testArgs, parsed.options)
  offlineEvalOptions = resolveOfflineEvalOptions(parsed.options)
} catch (error) {
  if (!(error instanceof OfflineEvalUsageError)) throw error
  console.error(`[run-tests] ${error.message}`)
  process.exit(error.exitCode)
}

const testDataRoot = mkdtempSync(join(tmpdir(), 'yma-test-run-'))
const inheritedTestEnv = offlineEvalMode
  ? sanitizeChildEnv({}, { sourceEnv: process.env })
  : { ...process.env }
const testEnv = { ...inheritedTestEnv, YMA_TEST_DATA_ROOT: testDataRoot }
const offlineEvalReportPath = offlineEvalMode
  ? join(testDataRoot, 'offline-eval-report.json')
  : null
if (offlineEvalMode) {
  testEnv.YMA_OFFLINE_EVAL_NETWORK_GUARD = '1'
  testEnv[OFFLINE_EVAL_OPTIONS_ENV] = JSON.stringify({
    suiteIds: offlineEvalOptions.suiteIds,
    baselinePath: offlineEvalOptions.baselinePath,
    reportPath: offlineEvalReportPath,
  })
}
const testSetupArgs = [
  '--import',
  './scripts/testEnvironment.mjs',
  ...(offlineEvalMode ? ['--import', './scripts/offlineEvalNetworkGuard.mjs'] : []),
]
const coverageMode = testArgs.includes('--coverage')
const selectors = testArgs.filter((arg) => !arg.startsWith('-'))
const nodeArgs = testArgs.filter((arg) => arg.startsWith('-') && arg !== '--run' && arg !== '--coverage')
const configuredConcurrency = Number(process.env.TEST_CONCURRENCY)
const defaultConcurrency = Math.max(1, Math.min(4, availableParallelism()))
const testConcurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
  ? Math.floor(configuredConcurrency)
  : defaultConcurrency
const DEFAULT_BATCH_TIMEOUT_MS = 20 * 60_000
const DEFAULT_ISOLATED_TIMEOUT_MS = 3 * 60_000
const PROCESS_TREE_KILL_GRACE_MS = 5_000

function positiveIntegerEnv(name, fallback) {
  const parsed = Number(process.env[name])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const batchTimeoutMs = positiveIntegerEnv('TEST_BATCH_TIMEOUT_MS', DEFAULT_BATCH_TIMEOUT_MS)
const isolatedTimeoutMs = positiveIntegerEnv('TEST_ISOLATED_TIMEOUT_MS', DEFAULT_ISOLATED_TIMEOUT_MS)
const batchNodeArgs = nodeArgs.some((arg) => arg.startsWith('--test-concurrency'))
  ? nodeArgs
  : [`--test-concurrency=${testConcurrency}`, ...nodeArgs]

const coverageArgs = coverageMode
  ? [
      '--experimental-test-coverage',
      `--test-coverage-lines=${process.env.COVERAGE_LINES || '40'}`,
      `--test-coverage-functions=${process.env.COVERAGE_FUNCTIONS || '35'}`,
      `--test-coverage-branches=${process.env.COVERAGE_BRANCHES || '60'}`,
      '--test-coverage-include=server/**/*.js',
      '--test-coverage-include=src/lib/**/*.js',
      '--test-coverage-include=shared/**/*.js',
    ]
  : []

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.test.js') || entry.endsWith('.test.jsx')) {
      out.push(full)
    }
  }
  return out
}

function allTestFiles() {
  return walk('tests')
    .filter((file) => normalize(file) !== normalize('tests/offlineCapabilityEval.test.js'))
    .sort()
}

function resolveSelector(selector) {
  if (selector === 'i18n') return ['tests/i18n.test.js']
  if (selector === 'offline-eval') return ['tests/offlineCapabilityEval.test.js']
  if (selector.startsWith('tests/')) return [selector]
  if (selector.endsWith('.test.js') || selector.endsWith('.test.jsx')) {
    return [`tests/${selector}`]
  }
  return [`tests/${selector}.test.js`]
}

const files = selectors.length
  ? selectors.flatMap(resolveSelector)
  : allTestFiles()

// These tests load rolldown either through the JSX hook or a Vite test
// wrapper. On Windows, running many rolldown instances in node:test workers
// can intermittently terminate a worker with access violation 0xC0000005.
// Run only that small group without an extra test worker; normal JavaScript
// tests keep their fast batched execution.
const viteWrapperTests = new Set([
  normalize('tests/ChatComposerSlashMenu.test.js'),
  normalize('tests/ChatStatusCard.test.js'),
  normalize('tests/RightPreviewPane.test.js'),
  normalize('tests/RightWorkbench.test.js'),
  normalize('tests/SlashInlinePanelHost.test.js'),
  normalize('tests/TaskProgressTable.test.js'),
])

function requiresNativeTransform(file) {
  return file.endsWith('.jsx') || viteWrapperTests.has(normalize(file))
}

const batchFiles = files.filter((file) => !requiresNativeTransform(file))
const isolatedFiles = files.filter(requiresNativeTransform)
const defaultBatchSize = process.platform === 'win32'
  ? 100
  : Math.max(1, batchFiles.length)
// Node evaluates coverage thresholds per process. Keep the normal Windows
// batching, but give coverage one complete test process so the gate represents
// the entire selected suite rather than an arbitrary 100-file slice.
const batchSize = coverageMode
  ? Math.max(1, batchFiles.length)
  : positiveIntegerEnv('TEST_BATCH_SIZE', defaultBatchSize)

function chunkFiles(source, size) {
  const chunks = []
  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size))
  }
  return chunks
}

function reportProcessError(result, label, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`[run-tests] ${label} exceeded ${timeoutMs}ms and was terminated`)
    return
  }
  if (result.error) {
    console.error(`[run-tests] ${label} failed to start: ${result.error.message}`)
  }
}

function timeoutError(timeoutMs) {
  const error = new Error(`Test process exceeded ${timeoutMs}ms`)
  error.code = 'ETIMEDOUT'
  return error
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    // child_process timeout only signals the direct process. node:test workers
    // (and tools started by a test) can keep inherited handles open forever on
    // Windows, which in turn makes spawnSync wait forever after its timeout.
    // taskkill is the supported way to terminate the complete descendant tree.
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {
        try { child.kill('SIGKILL') } catch { /* process already exited */ }
      })
      killer.unref()
    } catch {
      try { child.kill('SIGKILL') } catch { /* process already exited */ }
    }
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* process already exited */ }
  }
}

function runTestProcess(args, { captureOutput = false, streamOutput = false, timeoutMs }) {
  return new Promise((resolve) => {
    const stdout = []
    const stderr = []
    let settled = false
    let timedOut = false
    let timeoutHandle = null
    let forceResolveHandle = null
    let child

    const finish = (status, signal, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(forceResolveHandle)
      resolve({
        status,
        signal,
        error,
        stdout: captureOutput ? Buffer.concat(stdout) : null,
        stderr: captureOutput ? Buffer.concat(stderr) : null,
      })
    }

    try {
      child = spawn(process.execPath, args, {
        stdio: captureOutput || streamOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
        env: testEnv,
        windowsHide: true,
        // A dedicated process group lets POSIX runners terminate workers and
        // tool subprocesses along with the direct node:test process.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      finish(null, null, error)
      return
    }

    if (captureOutput || streamOutput) {
      child.stdout?.on('data', (chunk) => {
        if (captureOutput) stdout.push(Buffer.from(chunk))
        if (streamOutput) process.stdout.write(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (captureOutput) stderr.push(Buffer.from(chunk))
        if (streamOutput) process.stderr.write(chunk)
      })
    }

    child.once('error', (error) => finish(null, null, error))
    child.once('close', (status, signal) => {
      finish(status, signal, timedOut ? timeoutError(timeoutMs) : null)
    })

    timeoutHandle = setTimeout(() => {
      timedOut = true
      const error = timeoutError(timeoutMs)
      killProcessTree(child)
      forceResolveHandle = setTimeout(() => {
        // Never let a broken runner or inherited Windows handle hold the CI
        // harness open after the bounded tree-kill attempt.
        killProcessTree(child, 'SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
        child.unref()
        finish(null, null, error)
      }, PROCESS_TREE_KILL_GRACE_MS)
    }, timeoutMs)
  })
}

let failed = false
const failureSummaries = []

function processOutcome(result) {
  let status = 'failed'
  if (result.error?.code === 'ETIMEDOUT') status = 'timeout'
  else if (result.error) status = 'start-error'
  else if (isRetryableNativeCrash(result)) status = 'native-crash'
  else if (result.signal) status = 'signaled'

  return [
    `status=${status}`,
    `exitCode=${result.status ?? 'none'}`,
    `signal=${result.signal || 'none'}`,
    `errorCode=${result.error?.code || 'none'}`,
  ].join('; ')
}

function reportFailedProcess(result, label) {
  const tapFailures = tapFailureSummaries(result)
  const tapDetails = tapFailures.length
    ? `; tapFailures=${tapFailures.join(' | ')}`
    : ''
  const summary = `${label}; ${processOutcome(result)}${tapDetails}`
  console.error(`[run-tests] failed ${summary}`)
  return summary
}

function rememberFailure(summary) {
  if (summary && !failureSummaries.includes(summary)) failureSummaries.push(summary)
}

function reportCoverageFailure(result) {
  const details = coverageThresholdFailures(result).join('; ')
  const summary = `coverage gate; status=failed; ${details || 'threshold was not met'}`
  console.error(`[run-tests] failed ${summary}`)
  return summary
}

if (batchFiles.length) {
  const batches = chunkFiles(batchFiles, batchSize)
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    const label = `batch ${index + 1}/${batches.length} (${batch.length} files)`
    const startedAt = Date.now()
    console.log(`[run-tests] starting ${label}; timeout=${batchTimeoutMs}ms`)
    const result = await runTestProcess([
      ...testSetupArgs,
      '--test',
      ...coverageArgs,
      ...batchNodeArgs,
      ...batch,
    ], {
      captureOutput: true,
      streamOutput: !coverageMode,
      timeoutMs: batchTimeoutMs,
    })
    if (coverageMode) forwardCapturedOutput(result)
    reportProcessError(result, label, batchTimeoutMs)
    console.log(`[run-tests] finished ${label} in ${Date.now() - startedAt}ms; status=${result.status ?? 'none'}`)
    if ((result.status ?? 1) !== 0) {
      failed = true
      const coverageOnlyFailure = coverageMode
        && !hasTapFailure(result)
        && coverageThresholdFailures(result).length > 0
      rememberFailure(coverageOnlyFailure
        ? reportCoverageFailure(result)
        : reportFailedProcess(result, label))
    }
    if (result.error?.code === 'ETIMEDOUT') break
  }
}

function isRetryableNativeCrash(result) {
  return result.status === 3221225477
    || result.status === -1073741819
    || result.signal === 'SIGSEGV'
    || (result.signal === 'SIGABRT' && (
      /FATAL ERROR:[^\r\n]*(?:Allocation failed - process out of memory|JavaScript heap out of memory)/iu
        .test(capturedOutput(result))
    ))
}

function hasTapFailure(result) {
  const output = capturedOutput(result)

  return /^\s*not ok\b/m.test(output)
    || /^\s*# fail\s+[1-9]\d*\s*$/m.test(output)
}

function capturedOutput(result) {
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .map((chunk) => chunk.toString('utf8'))
    .join('\n')
}

function tapFailureSummaries(result) {
  const failures = []
  for (const match of capturedOutput(result).matchAll(
    /^\s*not ok\s+\d+\s+-\s+([^\r\n]+)/gmu,
  )) {
    const summary = match[1].trim().slice(0, 200)
    if (!summary || failures.includes(summary)) continue
    failures.push(summary)
    if (failures.length === 3) break
  }
  return failures
}

function coverageThresholdFailures(result) {
  return [...capturedOutput(result).matchAll(
    /^# Error: ([^\r\n]* coverage does not meet threshold of [^\r\n]+)\.?$/gmu,
  )].map((match) => match[1])
}

function forwardCapturedOutput(result) {
  if (result.stdout?.length) process.stdout.write(result.stdout)
  if (result.stderr?.length) process.stderr.write(result.stderr)
}

for (const file of isolatedFiles) {
  let passed = false
  let lastFailureSummary = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const loaderArgs = file.endsWith('.jsx')
      ? ['--import', './scripts/jsxRegister.mjs']
      : []
    const label = `isolated test ${file} (attempt ${attempt}/3)`
    console.log(`[run-tests] starting ${label}; timeout=${isolatedTimeoutMs}ms`)
    const result = await runTestProcess([
      ...testSetupArgs,
      ...loaderArgs,
      ...nodeArgs,
      file,
    ], {
      captureOutput: true,
      timeoutMs: isolatedTimeoutMs,
    })
    forwardCapturedOutput(result)
    reportProcessError(result, label, isolatedTimeoutMs)

    if (result.status === 0) {
      passed = true
      break
    }
    lastFailureSummary = reportFailedProcess(result, label)
    if (result.error?.code === 'ETIMEDOUT') break
    if (hasTapFailure(result) || !isRetryableNativeCrash(result) || attempt === 3) break
    console.warn(
      `[run-tests] native transform crashed for ${file}; retrying (${attempt + 1}/3)`,
    )
  }
  if (!passed) {
    failed = true
    rememberFailure(lastFailureSummary || `isolated test ${file}; status=failed; exitCode=unknown`)
  }
}

if (offlineEvalMode) {
  try {
    const report = readOfflineEvalReport(offlineEvalReportPath)
    if (offlineEvalOptions.jsonPath) {
      writeOfflineEvalJson(offlineEvalOptions.jsonPath, report)
    }
    if (offlineEvalReportFailed(report)) {
      for (const message of offlineEvalFailureMessages(report)) {
        console.error(`[run-tests] offline eval ${message}`)
        rememberFailure(`offline eval; status=failed; ${message}`)
      }
      failed = true
    }
  } catch (error) {
    const message = error?.message || String(error)
    console.error(`[run-tests] ${message}`)
    rememberFailure(`offline eval; status=failed; ${message}`)
    failed = true
  }
}

if (failed) {
  console.error(`[run-tests] final result: FAIL (${failureSummaries.length} final failure(s))`)
  for (const summary of failureSummaries) console.error(`[run-tests] - ${summary}`)
} else {
  console.log(`[run-tests] final result: PASS (${files.length} test file(s))`)
}

rmSync(testDataRoot, { recursive: true, force: true })
process.exit(failed ? 1 : 0)

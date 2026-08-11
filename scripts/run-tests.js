#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const testDataRoot = mkdtempSync(join(tmpdir(), 'yma-test-run-'))
const testEnv = { ...process.env, YMA_TEST_DATA_ROOT: testDataRoot }
const testSetupArgs = ['--import', './scripts/testEnvironment.mjs']
const coverageMode = rawArgs.includes('--coverage')
const selectors = rawArgs.filter((arg) => !arg.startsWith('-'))
const nodeArgs = rawArgs.filter((arg) => arg.startsWith('-') && arg !== '--run' && arg !== '--coverage')
const configuredConcurrency = Number(process.env.TEST_CONCURRENCY)
const defaultConcurrency = Math.max(1, Math.min(4, availableParallelism()))
const testConcurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
  ? Math.floor(configuredConcurrency)
  : defaultConcurrency
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
  return walk('tests').sort()
}

function resolveSelector(selector) {
  if (selector === 'i18n') return ['tests/i18n.test.js']
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
])

function requiresNativeTransform(file) {
  return file.endsWith('.jsx') || viteWrapperTests.has(normalize(file))
}

const batchFiles = files.filter((file) => !requiresNativeTransform(file))
const isolatedFiles = files.filter(requiresNativeTransform)

let failed = false

if (batchFiles.length) {
  const result = spawnSync(process.execPath, [
    ...testSetupArgs,
    '--test',
    ...coverageArgs,
    ...batchNodeArgs,
    ...batchFiles,
  ], {
    stdio: 'inherit',
    env: testEnv,
  })
  if ((result.status ?? 1) !== 0) failed = true
}

function isWindowsNativeCrash(result) {
  return result.status === 3221225477
    || result.status === -1073741819
    || result.signal === 'SIGSEGV'
}

function hasTapFailure(result) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .map((chunk) => chunk.toString('utf8'))
    .join('\n')

  return /^\s*not ok\b/m.test(output)
    || /^\s*# fail\s+[1-9]\d*\s*$/m.test(output)
}

function forwardCapturedOutput(result) {
  if (result.stdout?.length) process.stdout.write(result.stdout)
  if (result.stderr?.length) process.stderr.write(result.stderr)
}

for (const file of isolatedFiles) {
  let passed = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const loaderArgs = file.endsWith('.jsx')
      ? ['--import', './scripts/jsxRegister.mjs']
      : []
    const result = spawnSync(process.execPath, [
      ...testSetupArgs,
      ...loaderArgs,
      ...nodeArgs,
      file,
    ], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: testEnv,
    })
    forwardCapturedOutput(result)

    if (result.status === 0) {
      passed = true
      break
    }
    if (hasTapFailure(result) || !isWindowsNativeCrash(result) || attempt === 3) break
    console.warn(
      `[run-tests] native transform crashed for ${file}; retrying (${attempt + 1}/3)`,
    )
  }
  if (!passed) failed = true
}

rmSync(testDataRoot, { recursive: true, force: true })
process.exit(failed ? 1 : 0)

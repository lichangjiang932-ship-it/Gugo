import assert from 'node:assert/strict'
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OFFLINE_EVAL_REPORT_KIND,
  OFFLINE_EVAL_REPORT_SCHEMA_VERSION,
  OfflineEvalUsageError,
  assertOfflineEvalInvocation,
  offlineEvalReportFailed,
  parseOfflineEvalArgs,
  readOfflineEvalReport,
  resolveOfflineEvalOptions,
  writeOfflineEvalJson,
} from '../scripts/offlineEvalCli.js'

function report(overrides = {}) {
  return {
    kind: OFFLINE_EVAL_REPORT_KIND,
    schemaVersion: OFFLINE_EVAL_REPORT_SCHEMA_VERSION,
    suites: [{
      id: 'capability',
      title: 'Capability',
      version: 1,
      cases: [{
        suiteId: 'capability',
        id: 'CAP-01',
        status: 'passed',
        diagnostics: [],
      }],
    }],
    summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
    ...overrides,
  }
}

test('offline eval CLI extracts repeatable suites and singleton paths', () => {
  const parsed = parseOfflineEvalArgs([
    'offline-eval',
    '--eval-suite=capability',
    '--eval-suite',
    'plugin-revocation',
    '--eval-suite=capability',
    '--eval-json',
    'artifacts/eval.json',
    '--eval-baseline=baseline.json',
    '--test-name-pattern=eval',
  ])

  assert.deepEqual(parsed.options.suiteIds, ['capability', 'plugin-revocation'])
  assert.equal(parsed.options.jsonPath, 'artifacts/eval.json')
  assert.equal(parsed.options.baselinePath, 'baseline.json')
  assert.deepEqual(parsed.remainingArgs, ['offline-eval', '--test-name-pattern=eval'])
  assert.equal(assertOfflineEvalInvocation(parsed.remainingArgs, parsed.options), true)
})

test('offline eval CLI rejects unknown, empty, duplicate, and misplaced options', () => {
  const invalidArgs = [
    ['--eval-unknown=value'],
    ['--eval-suite='],
    ['--eval-suite=Uppercase'],
    ['--eval-json=a.json', '--eval-json=b.json'],
  ]
  for (const args of invalidArgs) {
    assert.throws(() => parseOfflineEvalArgs(args), OfflineEvalUsageError)
  }

  const parsed = parseOfflineEvalArgs(['unit', '--eval-suite=capability'])
  assert.throws(
    () => assertOfflineEvalInvocation(parsed.remainingArgs, parsed.options),
    OfflineEvalUsageError,
  )
})

test('offline eval CLI never resolves JSON output over its read-only baseline', () => {
  const parsed = parseOfflineEvalArgs([
    'offline-eval',
    '--eval-json=reports/main.json',
    '--eval-baseline=reports/../reports/main.json',
  ])
  assert.throws(
    () => resolveOfflineEvalOptions(parsed.options, 'C:\\workspace'),
    OfflineEvalUsageError,
  )
})

test('offline eval CLI protects baseline aliases and Windows case-insensitive paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-paths-'))
  try {
    const baselinePath = join(root, 'baseline.json')
    const aliasPath = join(root, 'alias.json')
    writeFileSync(baselinePath, '{}', 'utf8')
    linkSync(baselinePath, aliasPath)
    assert.throws(
      () => resolveOfflineEvalOptions({
        suiteIds: [],
        jsonPath: aliasPath,
        baselinePath,
      }),
      OfflineEvalUsageError,
    )

    assert.throws(
      () => resolveOfflineEvalOptions({
        suiteIds: [],
        jsonPath: 'Reports/Main.json',
        baselinePath: 'reports/main.JSON',
      }, root, 'win32'),
      OfflineEvalUsageError,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline eval report validation rejects missing, corrupt, and incompatible reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-cli-'))
  try {
    assert.throws(
      () => readOfflineEvalReport(join(root, 'missing.json')),
      { code: 'OFFLINE_EVAL_REPORT_INVALID' },
    )

    const corruptPath = join(root, 'corrupt.json')
    writeFileSync(corruptPath, '{', 'utf8')
    assert.throws(
      () => readOfflineEvalReport(corruptPath),
      { code: 'OFFLINE_EVAL_REPORT_INVALID' },
    )

    const incompatiblePath = join(root, 'incompatible.json')
    writeFileSync(incompatiblePath, JSON.stringify(report({ schemaVersion: 999 })), 'utf8')
    assert.throws(
      () => readOfflineEvalReport(incompatiblePath),
      { code: 'OFFLINE_EVAL_REPORT_INVALID' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline eval report validation binds summaries to unique case outcomes', () => {
  assert.throws(
    () => writeOfflineEvalJson('unused.json', report({
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      suites: [{
        id: 'capability',
        title: 'Capability',
        version: 1,
        cases: [{ id: 'CAP-01', suiteId: 'capability', status: 'failed' }],
      }],
    })),
    { code: 'OFFLINE_EVAL_REPORT_INVALID' },
  )
  assert.throws(
    () => writeOfflineEvalJson('unused.json', report({
      summary: { total: 2, passed: 2, failed: 0, skipped: 0 },
      suites: [{
        id: 'capability',
        title: 'Capability',
        version: 1,
        cases: [
          { id: 'CAP-01', suiteId: 'capability', status: 'passed' },
          { id: 'CAP-01', suiteId: 'capability', status: 'passed' },
        ],
      }],
    })),
    { code: 'OFFLINE_EVAL_REPORT_INVALID' },
  )
})

test('offline eval JSON output is validated and baseline regressions fail the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-json-'))
  try {
    const outputPath = join(root, 'nested', 'report.json')
    const current = report()
    writeOfflineEvalJson(outputPath, current)
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), current)
    assert.equal(offlineEvalReportFailed(current), false)
    assert.equal(offlineEvalReportFailed(report({
      baseline: {
        compared: true,
        compatible: true,
        regressions: ['capability/CAP-01'],
        missingCases: [],
      },
    })), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

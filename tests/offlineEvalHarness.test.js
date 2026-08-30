import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { validateOfflineEvalReport } from '../scripts/offlineEvalCli.js'
import {
  compareOfflineEvalBaseline,
  createOfflineEvalFailureReport,
  defineOfflineEvalCase,
  defineOfflineEvalSuite,
  discoverOfflineEvalSuites,
  offlineEvalSuiteSourcePath,
  parseOfflineEvalOptions,
  runOfflineEvalSuites,
  writeOfflineEvalReport,
} from './helpers/offlineEvalHarness.js'

function evalCase(id, run = async () => {}) {
  return defineOfflineEvalCase({
    id,
    category: 'contract',
    title: `Case ${id}`,
    run,
  })
}

function suite(id, cases = [evalCase(`${id.toUpperCase()}-01`)]) {
  return defineOfflineEvalSuite({ id, title: `Suite ${id}`, version: 1, cases })
}

test('offline eval definitions are frozen and reject invalid or duplicate identities', () => {
  const first = evalCase('CASE-01')
  const defined = suite('alpha', [first])
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(defined), true)
  assert.equal(Object.isFrozen(defined.cases), true)
  assert.throws(
    () => suite('alpha', [first, first]),
    { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
  )
  assert.throws(
    () => defineOfflineEvalCase({ id: 'bad id', category: 'x', title: 'x', run() {} }),
    { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
  )
  for (const frozenCase of [
    Object.freeze({ id: 'FROZEN-01', category: '', title: 'Missing category', run() {} }),
    Object.freeze({ id: 'FROZEN-02', category: 'contract', title: 'Bad timeout', timeoutMs: -1, run() {} }),
  ]) {
    assert.throws(
      () => suite('alpha', [frozenCase]),
      { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
    )
  }
})

test('offline eval discovery is deterministic and rejects duplicate suite ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-discovery-'))
  try {
    writeFileSync(join(root, 'z.eval.js'), '', 'utf8')
    writeFileSync(join(root, 'a.eval.js'), '', 'utf8')
    writeFileSync(join(root, 'ignored.test.js'), '', 'utf8')
    const modules = new Map([
      ['a.eval.js', { default: suite('zeta') }],
      ['z.eval.js', { default: suite('alpha') }],
    ])
    const discovered = await discoverOfflineEvalSuites({
      directory: root,
      loadModule: async (filePath) => modules.get(basename(filePath)),
    })
    assert.deepEqual(discovered.map((entry) => entry.id), ['alpha', 'zeta'])
    assert.equal(offlineEvalSuiteSourcePath(discovered[0]), join(root, 'z.eval.js'))
    assert.equal(offlineEvalSuiteSourcePath(discovered[1]), join(root, 'a.eval.js'))

    await assert.rejects(
      discoverOfflineEvalSuites({
        directory: root,
        loadModule: async () => ({ default: suite('duplicate') }),
      }),
      { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline eval execution cleans up LIFO, redacts diagnostics, and bounds a hung case', async () => {
  const cleanupOrder = []
  const evaluatedSuite = suite('runtime', [
    evalCase('PASS-01', async (ctx) => {
      ctx.defer(() => cleanupOrder.push('first'))
      ctx.defer(() => cleanupOrder.push('second'))
      ctx.metric('score', 1)
      ctx.diagnostic('token=super-secret-value')
      ctx.diagnostic({
        api_key: 'structured-api-secret',
        apiKey: 'structured-camel-api-secret',
        token: 'structured-token-secret',
        password: 'structured-password-secret',
        headers: { authorization: 'Basic structured-authorization-secret' },
        nested: { client_secret: 'structured-client-secret', visible: 'kept' },
      })
      ctx.diagnostic(JSON.stringify({
        api_key: 'json-api-secret',
        authorization: 'Basic json-authorization-secret',
      }))
    }),
    evalCase('CLEANUP-01', async (ctx) => {
      ctx.defer(() => {
        throw new Error('Bearer cleanup-private-token')
      })
    }),
    defineOfflineEvalCase({
      id: 'TIMEOUT-01',
      category: 'timeout',
      title: 'Hung case',
      timeoutMs: 20,
      run: async () => new Promise(() => {}),
    }),
  ])

  const startedAt = Date.now()
  const report = await runOfflineEvalSuites({ suites: [evaluatedSuite] })
  assert.ok(Date.now() - startedAt < 500, 'hung case must not hang the harness')
  assert.deepEqual(cleanupOrder, ['second', 'first'])
  assert.deepEqual(report.summary, { total: 3, passed: 1, failed: 2, skipped: 0 })
  assert.deepEqual(report.suites[0].cases[0].metrics, { score: 1 })
  const diagnostics = report.suites[0].cases[0].diagnostics.join('\n')
  for (const secret of [
    'super-secret-value',
    'structured-api-secret',
    'structured-camel-api-secret',
    'structured-token-secret',
    'structured-password-secret',
    'structured-authorization-secret',
    'structured-client-secret',
    'json-api-secret',
    'json-authorization-secret',
  ]) {
    assert.doesNotMatch(diagnostics, new RegExp(secret, 'u'))
  }
  assert.match(diagnostics, /"visible":"kept"/u)
  assert.match(diagnostics, /\[REDACTED\]/u)
  assert.match(report.suites[0].cases[1].diagnostics.join('\n'), /\[REDACTED\]/u)
  assert.match(report.suites[0].cases[2].diagnostics.join('\n'), /OFFLINE_EVAL_CASE_TIMEOUT/u)
  validateOfflineEvalReport(report)
})

test('offline eval runner fails closed when a callback skips execution or selects an unknown suite', async () => {
  const definedSuite = suite('selected')
  const report = await runOfflineEvalSuites({
    suites: [definedSuite],
    selectedSuiteIds: ['selected'],
    runCase: async () => null,
  })
  assert.equal(report.summary.failed, 1)
  assert.match(report.suites[0].cases[0].diagnostics[0], /did not execute/u)
  assert.deepEqual(report.selection, { mode: 'filtered', suiteIds: ['selected'] })

  await assert.rejects(
    runOfflineEvalSuites({ suites: [definedSuite], selectedSuiteIds: ['missing'] }),
    { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
  )
})

test('offline eval baseline detects regressions, removed cases, removed suites, and new cases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-baseline-'))
  try {
    const baselinePath = join(root, 'baseline.json')
    const baseline = {
      kind: 'gugo.offline-eval-report',
      schemaVersion: 1,
      suites: [
        {
          id: 'alpha',
          version: 1,
          cases: [
            { id: 'A-01', status: 'passed' },
            { id: 'A-REMOVED', status: 'passed' },
          ],
        },
        { id: 'removed-suite', version: 1, cases: [{ id: 'R-01', status: 'passed' }] },
      ],
    }
    writeFileSync(baselinePath, JSON.stringify(baseline), 'utf8')
    const current = {
      kind: 'gugo.offline-eval-report',
      schemaVersion: 1,
      selection: { mode: 'all', suiteIds: ['alpha'] },
      suites: [{
        id: 'alpha',
        version: 1,
        cases: [
          { id: 'A-01', status: 'failed' },
          { id: 'A-NEW', status: 'passed' },
        ],
      }],
      summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    }
    const compared = await compareOfflineEvalBaseline(current, baselinePath)
    assert.equal(compared.baseline.compatible, true)
    assert.deepEqual(compared.baseline.regressions.map((entry) => entry.caseId), ['A-01'])
    assert.deepEqual(
      compared.baseline.missingCases.map((entry) => `${entry.suiteId}/${entry.caseId}`).sort(),
      ['alpha/A-REMOVED', 'removed-suite/R-01'],
    )
    assert.deepEqual(compared.baseline.newCases, [{ suiteId: 'alpha', caseId: 'A-NEW' }])

    const filtered = await compareOfflineEvalBaseline({
      ...current,
      selection: { mode: 'filtered', suiteIds: ['alpha'] },
    }, baselinePath)
    assert.deepEqual(
      filtered.baseline.missingCases.map((entry) => `${entry.suiteId}/${entry.caseId}`),
      ['alpha/A-REMOVED'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline eval baseline and option parsing fail closed on incompatible input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-incompatible-'))
  try {
    const baselinePath = join(root, 'baseline.json')
    writeFileSync(baselinePath, JSON.stringify({
      kind: 'gugo.offline-eval-report',
      schemaVersion: 999,
      suites: [],
    }), 'utf8')
    const fallback = createOfflineEvalFailureReport(new Error('token=private-value'))
    const compared = await compareOfflineEvalBaseline(fallback, baselinePath)
    assert.equal(compared.baseline.compatible, false)
    assert.doesNotMatch(fallback.suites[0].cases[0].diagnostics[0], /private-value/u)
    validateOfflineEvalReport(fallback)

    assert.throws(
      () => parseOfflineEvalOptions(JSON.stringify({ suiteIds: 'capability' })),
      { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
    )
    assert.throws(
      () => parseOfflineEvalOptions(JSON.stringify({ suiteIds: ['CAPABILITY'] })),
      { code: 'OFFLINE_EVAL_DEFINITION_INVALID' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline eval report writer creates a validated nested JSON report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-report-'))
  try {
    const outputPath = join(root, 'nested', 'report.json')
    const report = await runOfflineEvalSuites({ suites: [suite('writer')] })
    await writeOfflineEvalReport(outputPath, report)
    assert.deepEqual(validateOfflineEvalReport(JSON.parse(readFileSync(outputPath, 'utf8'))), report)

    const invalidPath = join(root, 'nested', 'invalid-report.json')
    await assert.rejects(
      writeOfflineEvalReport(invalidPath, {
        ...report,
        summary: { ...report.summary, passed: report.summary.passed + 1 },
      }),
      { code: 'OFFLINE_EVAL_REPORT_INVALID' },
    )
    assert.equal(existsSync(invalidPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

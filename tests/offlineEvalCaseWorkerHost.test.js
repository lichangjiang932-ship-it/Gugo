import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  offlineEvalCaseWorkerDeadlineMs,
  runOfflineEvalCaseInWorker,
} from './helpers/offlineEvalCaseWorkerHost.js'

test('offline eval worker deadlines preserve short fixtures and bound cold-start grace', () => {
  assert.equal(offlineEvalCaseWorkerDeadlineMs({ timeoutMs: 20 }), 1_520)
  assert.equal(offlineEvalCaseWorkerDeadlineMs({}), 9_000)
  assert.equal(offlineEvalCaseWorkerDeadlineMs({ timeoutMs: 20_000 }), 24_000)
})

function fixtureSource(harnessUrl, markerPath) {
  return `
    import { writeFileSync } from 'node:fs'
    import { defineOfflineEvalCase, defineOfflineEvalSuite } from ${JSON.stringify(harnessUrl)}

    export default defineOfflineEvalSuite({
      id: 'worker-isolation',
      title: 'Worker isolation fixture',
      version: 1,
      cases: [
        defineOfflineEvalCase({
          id: 'LATE-WRITE',
          category: 'timeout',
          title: 'Timed-out work cannot escape its worker',
          timeoutMs: 20,
          run: async () => {
            setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'escaped'), 100)
            return new Promise(() => {})
          },
        }),
        defineOfflineEvalCase({
          id: 'SYNC-SPIN',
          category: 'timeout',
          title: 'Synchronous hangs are terminated',
          timeoutMs: 20,
          run: () => {
            while (true) { /* fixture intentionally spins */ }
          },
        }),
        defineOfflineEvalCase({
          id: 'PASS',
          category: 'isolation',
          title: 'A later case still runs',
          run: async (ctx) => ctx.metric('isolated', 1),
        }),
      ],
    })
  `
}

test('offline eval workers terminate timed-out work and isolate later cases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-offline-eval-worker-'))
  const markerPath = join(root, 'late-write.txt')
  try {
    const harnessUrl = pathToFileURL(resolve('tests/helpers/offlineEvalHarness.js')).href
    const fixturePath = join(root, 'worker.eval.js')
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', 'utf8')
    writeFileSync(fixturePath, fixtureSource(harnessUrl, markerPath), 'utf8')
    const suite = (await import(`${pathToFileURL(fixturePath).href}?fixture=${Date.now()}`)).default

    const late = await runOfflineEvalCaseInWorker({
      suite,
      evalCase: suite.cases[0],
      suiteDirectory: root,
    })
    assert.equal(late.outcome.status, 'failed')
    assert.match(late.outcome.diagnostics.join('\n'), /OFFLINE_EVAL_CASE_TIMEOUT/u)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    assert.equal(existsSync(markerPath), false)

    const spin = await runOfflineEvalCaseInWorker({
      suite,
      evalCase: suite.cases[1],
      suiteDirectory: root,
    })
    assert.equal(spin.outcome.status, 'failed')
    assert.match(spin.outcome.diagnostics.join('\n'), /OFFLINE_EVAL_CASE_HARD_TIMEOUT/u)

    const passing = await runOfflineEvalCaseInWorker({
      suite,
      evalCase: suite.cases[2],
      suiteDirectory: root,
    })
    assert.equal(passing.outcome.status, 'passed')
    assert.deepEqual(passing.outcome.metrics, { isolated: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

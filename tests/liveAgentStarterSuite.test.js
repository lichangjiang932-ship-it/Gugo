import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadLiveEvalDataset } from '../scripts/run-live-agent-evals.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetPath = path.join(root, 'evals', 'starter-suite.json')

test('starter live-eval suite has isolated immutable verifiers and intentionally failing source fixtures', async () => {
  const dataset = await loadLiveEvalDataset(datasetPath)
  assert.deepEqual(dataset.tasks.map((task) => task.id), [
    'starter-counter-repair',
    'starter-config-hardening',
    'starter-report-repair',
  ])
  for (const task of dataset.tasks) {
    assert.equal(task.mode, 'bypass')
    assert.equal(task.verifiers.length, 1)
    const verifier = task.verifiers[0]
    assert.ok(verifier.script)
    assert.equal(path.relative(task.source, verifier.script).startsWith('..'), true)
    const baseline = spawnSync(verifier.command, verifier.args, {
      cwd: task.source,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    })
    assert.notEqual(baseline.status, 0, `${task.id} must begin unsolved`)
  }
})

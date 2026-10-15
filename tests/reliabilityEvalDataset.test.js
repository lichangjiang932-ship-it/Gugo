import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadLiveEvalDataset } from '../scripts/run-live-agent-evals.mjs'
import { verifyLedger, verifyRename, verifyCache } from '../evals/verifiers/reliability.mjs'
import { aggregate as brokenLedger } from '../evals/fixtures/ledger-snapshot-repair/src/ledger.js'
import { createRenamer as brokenRename } from '../evals/fixtures/rename-order-repair/src/rename.js'
import { classify as brokenCache } from '../evals/fixtures/cache-unknown-repair/src/cache.js'

test('the explicit live dataset loads without invoking any model and contains scoped fixtures', async () => {
  const dataset = await loadLiveEvalDataset(fileURLToPath(new URL('../evals/reliability-suite.json', import.meta.url)))
  assert.equal(dataset.tasks.length, 3)
  assert.ok(dataset.tasks.every(task => task.mode === 'acceptEdits' && task.verifiers.length === 1))
})
test('hidden verifiers reject shipped defects', async () => {
  assert.throws(() => verifyLedger(brokenLedger))
  await assert.rejects(verifyRename(brokenRename))
  assert.throws(() => verifyCache(brokenCache))
})
test('hidden ledger and queue verifiers accept correct reference implementations', async () => {
  verifyLedger((events, { since = null } = {}) => {
    const rows = events.filter(row => since == null || row.at >= since), latest = new Map()
    for (const row of rows.filter(row => row.type.startsWith('turn.'))) {
      const key = JSON.stringify([row.userId, row.sessionId, row.turnId])
      if (!latest.has(key) || latest.get(key).sequence < row.sequence) latest.set(key, row)
    }
    const valid = rows => rows.reduce((sum, row) => sum + (typeof row.promptTokens === 'number' && Number.isFinite(row.promptTokens) && row.promptTokens >= 0 ? row.promptTokens : 0), 0)
    return { turns: latest.size, promptTokens: valid(since == null ? [...latest.values()] : rows.filter(row => row.type === 'model.phase')) }
  })
  await verifyRename(write => {
    const queues = new Map()
    return (id, title) => {
      const previous = queues.get(id) || Promise.resolve()
      const operation = previous.catch(() => {}).then(() => write(id, title))
      queues.set(id, operation)
      return operation
    }
  })
})

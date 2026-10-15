import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { sortSessions, timestampOf, pinnedTimestampOf } from '../src/components/leftRail/sessionListUtils.js'
const sessions = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), updatedAt: new Date(1700000000000 + ((i * 97) % 4999) * 1000).toISOString(), pinnedAt: i % 30 === 0 ? 1700000000000 + i : null }))
const baseline = input => input.map((session, index) => ({ session, index })).sort((a, b) => {
  const ap = pinnedTimestampOf(a.session), bp = pinnedTimestampOf(b.session)
  if (!!ap !== !!bp) return ap ? -1 : 1
  if (ap) { const difference = bp - ap; if (difference) return difference; const ids = a.session.id.localeCompare(b.session.id); if (ids) return ids }
  return timestampOf(b.session) - timestampOf(a.session) || a.index - b.index
}).map(item => item.session)
const runs = { baseline: [], decorated: [] }
for (let i = 0; i < 30; i++) {
  let start = performance.now(); const before = baseline(sessions); runs.baseline.push(performance.now() - start)
  start = performance.now(); const after = sortSessions(sessions); runs.decorated.push(performance.now() - start)
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id))
}
const summary = values => { values.sort((a, b) => a - b); return { medianMs: values[15], p95Ms: values[28] } }
process.stdout.write(JSON.stringify({ version: 1, sessions: sessions.length, updates: 30, correctness: 'identical ordering', baseline: summary(runs.baseline), decorated: summary(runs.decorated), scope: 'Node-side sort benchmark, not browser FPS' }, null, 2) + '\n')

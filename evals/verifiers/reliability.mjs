import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

export function verifyLedger(aggregate) {
  const event = (sequence, tokens, type = 'turn.completed', extra = {}) => ({ userId: 'u', sessionId: 's', turnId: 't', sequence, at: sequence * 1000, type, promptTokens: tokens, ...extra })
  const input = [event(4, 800), event(3, 300, 'model.phase'), event(2, 500, 'turn.paused'), event(1, 500, 'model.phase')]
  const copy = structuredClone(input)
  assert.deepEqual(aggregate(input), { turns: 1, promptTokens: 800 })
  assert.deepEqual(input, copy)
  assert.deepEqual(aggregate(input, { since: 2500 }), { turns: 1, promptTokens: 300 })
  assert.deepEqual(aggregate([event(1, 20), event(1, 30, 'turn.completed', { userId: 'other' })]), { turns: 2, promptTokens: 50 })
  assert.deepEqual(aggregate([event(2, 80, 'turn.failed', { at: 1 }), event(1, 50, 'turn.paused', { at: 9999 })]), { turns: 1, promptTokens: 80 })
  assert.deepEqual(aggregate([]), { turns: 0, promptTokens: 0 })
  for (const tokens of [null, undefined, -1, '500', Infinity, NaN]) assert.equal(aggregate([event(1, tokens)]).promptTokens, 0)
}
export async function verifyRename(createRenamer) {
  let release, entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const writes = [], stored = new Map()
  const rename = createRenamer(async (id, title) => {
    writes.push([id, title])
    if (title === 'A') { entered(); await gate }
    if (title === 'refused') throw new Error('refused')
    stored.set(id, title); return title
  })
  const a = rename('s', 'A'); await enteredPromise
  const b = rename('s', 'B')
  const other = rename('other', 'C')
  assert.equal(await other, 'C')
  assert.equal(writes.filter(([id]) => id === 's').length, 1)
  release(); assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
  assert.equal(stored.get('s'), 'B')
  await assert.rejects(rename('s', 'refused'))
  assert.equal(await rename('s', 'D'), 'D')
  assert.equal(writes.filter(([, title]) => title === 'refused').length, 1)
}
export function verifyCache(classify) {
  const unknown = { readReported: false, writeReported: false, hitRate: null }
  assert.deepEqual(classify({ promptTokens: 100 }), unknown)
  assert.deepEqual(classify({ promptTokens: 100, cacheCreationTokens: 0 }), { ...unknown, writeReported: true })
  assert.deepEqual(classify({ promptTokens: 100, cacheHitTokens: 0 }), { readReported: true, writeReported: false, hitRate: 0 })
  assert.deepEqual(classify({ promptTokens: 100, cacheMissTokens: 80 }), { readReported: true, writeReported: false, hitRate: 20 })
  for (const values of [{ cacheHitTokens: 20, cacheMissTokens: 70 }, { cacheHitTokens: 120 }, { cacheHitTokens: [] }, { cacheMissTokens: -1 }]) {
    assert.deepEqual(classify({ promptTokens: 100, ...values }), unknown)
  }
}
async function main(id) {
  const file = id.startsWith('ledger') ? 'ledger' : id.startsWith('rename') ? 'rename' : id.startsWith('cache') ? 'cache' : null
  if (!file) throw new Error('Unknown reliability task')
  const module = await import(pathToFileURL(path.resolve('src', file + '.js')).href)
  if (file === 'ledger') verifyLedger(module.aggregate)
  else if (file === 'rename') await verifyRename(module.createRenamer)
  else verifyCache(module.classify)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2] || '')

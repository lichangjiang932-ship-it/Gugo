import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { runTask } = await import(pathToFileURL(path.resolve('src/worker.js')).href)
const early = new AbortController()
early.abort()
let earlyCalls = 0
await assert.rejects(async () => runTask({ signal: early.signal, work: () => { earlyCalls += 1 } }), { name: 'AbortError' })
assert.equal(earlyCalls, 0)
const active = new AbortController()
let settle
const pending = new Promise((resolve) => { settle = resolve })
let started
const ready = new Promise((resolve) => { started = resolve })
const result = runTask({ signal: active.signal, work: () => { started(); return pending } })
await ready
let deadline
const timeout = new Promise((_, reject) => {
  deadline = setTimeout(() => reject(new Error('cancellation did not settle before late work')), 2000)
})
const rejected = assert.rejects(Promise.race([result, timeout]), { name: 'AbortError' })
active.abort()
try { await rejected } finally { clearTimeout(deadline); settle('late result') }
const normal = new AbortController()
assert.equal(await runTask({ signal: normal.signal, work: async () => 42 }), 42)

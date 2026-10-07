import assert from 'node:assert/strict'
import { runTask } from './src/worker.js'
const controller = new AbortController()
controller.abort()
let calls = 0
await assert.rejects(() => runTask({ signal: controller.signal, work: () => { calls += 1 } }), { name: 'AbortError' })
assert.equal(calls, 0)

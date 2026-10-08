import test from 'node:test'
import assert from 'node:assert/strict'

import { createMutationContentBinding } from '../server/services/loop/mutationContentBinding.js'
import { clearVerifiedMutationTargets } from '../server/services/loop/heuristics/mutationVerification.js'

// A read-back used to clear a file's verification debt by path alone: a write
// that "succeeded" but left the file truncated or empty was verified by any read.

const WROTE = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const read = (sha256) => ({ ok: true, path: 'src/app.js', content: 'x', totalLines: 1, returnedLines: 1, offset: 0, sha256 })

test('a read-back clears a write only when it finds the bytes the write reported', () => {
  const binding = createMutationContentBinding()
  binding.observe(['src/app.js'], { ok: true, sha256: WROTE })
  const pending = new Set(['src/app.js'])
  const call = { name: 'read_file', args: { path: 'src/app.js' } }
  assert.equal(clearVerifiedMutationTargets(pending, call, read(OTHER), { contentBinding: binding }), false)
  assert.ok(pending.has('src/app.js'), 'different bytes on disk: the write is not verified')
  assert.equal(clearVerifiedMutationTargets(pending, call, read(WROTE), { contentBinding: binding }), true)
  assert.equal(pending.size, 0)
})

test('a mutation that reports no digest keeps the path rule; a later digest replaces it', () => {
  const binding = createMutationContentBinding()
  binding.observe(['src/app.js'], { ok: true, sha256: WROTE })
  binding.observe(['src/app.js'], { ok: true, exitCode: 0 })
  assert.equal(binding.readMatches('src/app.js', read(OTHER)), true, 'a script rewrote it; there is no intent to compare against')
  binding.observe(['src/a.js', 'src/b.js'], { ok: true, sha256: WROTE })
  assert.equal(binding.expectedDigest('src/a.js'), null, 'one digest says nothing about each of several files')
})

test('the expectation survives a checkpoint and ignores malformed entries', () => {
  const binding = createMutationContentBinding()
  binding.observe(['src/app.js'], { ok: true, sha256: WROTE })
  const restored = createMutationContentBinding({ ...binding.serialize(), 'src/bad.js': 'not-a-digest' })
  assert.equal(restored.expectedDigest('src/app.js'), WROTE)
  assert.equal(restored.expectedDigest('src/bad.js'), null)
})

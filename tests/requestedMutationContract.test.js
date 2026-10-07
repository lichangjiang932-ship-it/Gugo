import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createRequestedMutationContract, requestedFileMutations } from '../server/services/loop/requestedMutationContract.js'

const scope = { userId: 'owner', jobId: 'turn', sessionId: 'session', projectDirectory: path.resolve('project') }
const prompt = 'Update both src/a.js and src/b.js and verify each change.'
const contract = (restored = null) => createRequestedMutationContract({
  text: prompt, scope, enabled: true, restored,
})

test('required writes distinguish output names from input, inspection, quoted code and prohibitions', () => {
  assert.deepEqual(requestedFileMutations(prompt), ['src/a.js', 'src/b.js'])
  assert.deepEqual(requestedFileMutations('Update src/a.js and src/b.js using examples/input.js; read README.md.'),
    ['src/a.js', 'src/b.js'])
  assert.deepEqual(requestedFileMutations('Do not update src/a.js and src/b.js.'), [])
  assert.deepEqual(requestedFileMutations('Explain this example:\n```\nUpdate src/a.js and src/b.js\n```'), [])
  assert.deepEqual(requestedFileMutations('请修改 src/a.js 和 src/b.js，然后检查 README.md。'),
    ['src/a.js', 'src/b.js'])
  assert.deepEqual(requestedFileMutations('请把 src/a.js 和 src/b.js 都修复好。'), ['src/a.js', 'src/b.js'])
})

test('every explicit required output needs matching evidence in the selected project', () => {
  const value = contract()
  assert.equal(value.satisfied(), false)
  value.record([path.resolve('other-project', 'src/a.js')])
  assert.deepEqual(value.missing(), ['src/a.js', 'src/b.js'])
  value.record([path.join(scope.projectDirectory, 'src/a.js')])
  assert.deepEqual(value.missing(), ['src/b.js'])
  value.record(['src/b.js'])
  assert.equal(value.satisfied(), true)
})

test('a cold checkpoint restores observed writes without erasing remaining requirements or crossing owners', () => {
  const value = contract()
  value.record(['src/a.js'])
  const snapshot = JSON.parse(JSON.stringify(value.snapshot()))
  const restored = contract(snapshot)
  assert.deepEqual(restored.missing(), ['src/b.js'])
  const foreign = createRequestedMutationContract({
    text: prompt, scope: { ...scope, userId: 'another-owner' }, enabled: true, restored: snapshot,
  })
  assert.deepEqual(foreign.missing(), ['src/a.js', 'src/b.js'])
  const anotherProject = createRequestedMutationContract({
    text: prompt, scope: { ...scope, projectDirectory: path.resolve('another-project') },
    enabled: true, restored: snapshot,
  })
  assert.deepEqual(anotherProject.missing(), ['src/a.js', 'src/b.js'])
  assert.throws(() => contract({ ...snapshot, version: 2 }), {
    code: 'REQUESTED_MUTATION_CONTRACT_INVALID',
  })
})

test('new user steering may add, cancel or replace requirements and invalidates stale evidence', () => {
  const value = contract()
  value.record(['src/a.js'])
  value.steer('Also update src/c.js.')
  assert.deepEqual(value.missing(), ['src/b.js', 'src/c.js'])
  value.steer('Do not update src/b.js.')
  assert.deepEqual(value.missing(), ['src/c.js'])
  value.steer('Update only src/a.js instead.')
  assert.deepEqual(value.missing(), ['src/a.js'])
  value.record(['src/a.js'])
  assert.equal(value.satisfied(), true)
  assert.deepEqual(contract(value.snapshot()).missing(), [])
})

test('inspection-only qualifiers do not cancel unfinished writes and large target lists are not silently truncated', () => {
  const value = contract()
  value.steer('Also update src/c.js and only read README.md for verification.')
  assert.deepEqual(value.missing(), ['src/a.js', 'src/b.js', 'src/c.js'])
  value.steer('Only update src/c.js.')
  assert.deepEqual(value.missing(), ['src/c.js'])
  value.steer('Update src/d.js instead of src/c.js.')
  assert.deepEqual(value.missing(), ['src/d.js'])
  assert.equal(requestedFileMutations('Update ' + Array.from({ length: 80 }, (_, index) => `src/f${index}.js`).join(' and ')).length, 80)
  assert.throws(() => requestedFileMutations('Update ' + Array.from({ length: 513 }, (_, index) => `f${index}.js`).join(' and ')), {
    code: 'REQUESTED_MUTATION_CONTRACT_LIMIT',
  })
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('task center uses backend job client instead of transient app tasks', () => {
  const source = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')
  assert.match(source, /createJob/)
  assert.match(source, /listJobs/)
  assert.match(source, /cancelJob/)
  assert.match(source, /subscribeToJobEvents/)
  assert.doesNotMatch(source, /state\.tasks/)
})


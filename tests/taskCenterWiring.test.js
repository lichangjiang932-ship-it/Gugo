import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('task center uses backend job client instead of transient app tasks', () => {
  const source = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')
  assert.match(source, /createJob/)
  assert.match(source, /listJobs/)
  assert.match(source, /cancelJob/)
  assert.match(source, /subscribeToJobEvents/)
  assert.match(source, /useSearchParams/)
  assert.doesNotMatch(source, /state\.tasks/)
})

test('task notifications deep-link to the routed task and legacy plural links remain supported', () => {
  const runtimeSource = fs.readFileSync(new URL('../server/services/jobRuntime.js', import.meta.url), 'utf8')
  const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  assert.match(runtimeSource, /`\/task\?job=\$\{encodeURIComponent\(job\.id\)\}`/)
  assert.doesNotMatch(runtimeSource, /`\/tasks\?job=/)
  assert.match(appSource, /path="\/tasks" element=\{<RoutedTaskRunPanel \/>\}/)
})


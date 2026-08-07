import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('task center uses backend job client instead of transient app tasks', () => {
  const pageSource = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')
  const controllerSource = fs.readFileSync(new URL('../src/pages/taskRun/useTaskRunController.js', import.meta.url), 'utf8')
  assert.match(controllerSource, /createJob/)
  assert.match(controllerSource, /listJobs/)
  assert.match(controllerSource, /cancelJob/)
  assert.match(controllerSource, /subscribeToJobEvents/)
  assert.match(pageSource, /useSearchParams/)
  assert.doesNotMatch(`${pageSource}\n${controllerSource}`, /state\.tasks/)
})

test('task notifications deep-link to the routed task and legacy plural links remain supported', () => {
  const runtimeSource = fs.readFileSync(new URL('../server/services/jobRuntime.js', import.meta.url), 'utf8')
  const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  assert.match(runtimeSource, /`\/task\?job=\$\{encodeURIComponent\(job\.id\)\}`/)
  assert.doesNotMatch(runtimeSource, /`\/tasks\?job=/)
  assert.match(
    appSource,
    /path="\/tasks" element=\{<RequireAuth><RoutedTaskRunPanel \/><\/RequireAuth>\}/,
  )
})


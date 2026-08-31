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
  assert.match(controllerSource, /readStoredModelSelection/)
  assert.match(controllerSource, /resolveTaskModelPreflight/)
  assert.match(controllerSource, /setModelReadiness\(loadingTaskModelReadiness/)
  assert.match(controllerSource, /addEventListener\('model-providers:changed'/)
  assert.match(controllerSource, /event\.key === SELECTED_MODEL_STORAGE_KEY/)
  assert.match(controllerSource, /providerId:\s*preflight\.selection\.providerId/)
  assert.match(controllerSource, /function taskRunErrorRecovery/)
  assert.match(controllerSource, /action: 'verify_model_request'/)
  assert.match(controllerSource, /action: 'recreate_job'/)
  assert.match(controllerSource, /modelRecoveryTarget/)
  assert.doesNotMatch(controllerSource, /code\.startsWith\('MODEL_'\)/)
  assert.equal((controllerSource.match(/captureError\(reason/g) || []).length, 3)
  assert.match(pageSource, /const openModelSettings = \(\) => navigate\(settingsPathForSection/)
  assert.match(pageSource, /\{ returnTo: taskReturnTo \}/)
  assert.match(pageSource, /:\s*location\.pathname\)/)
  assert.match(pageSource, /scopeKind.*job|controller\.modelRecoveryTarget/)
  assert.match(pageSource, /errorAction=\{controller\.errorAction\}/)
  assert.match(pageSource, /modelReadiness=\{controller\.modelReadiness\}/)
  assert.match(pageSource, /onRetryModelStatus=\{controller\.reloadModelReadiness\}/)
  assert.match(pageSource, /useSearchParams/)
  assert.doesNotMatch(`${pageSource}\n${controllerSource}`, /state\.tasks/)
})

test('task notifications deep-link to the routed task and legacy plural links remain supported', () => {
  const runtimeSource = [
    '../server/services/jobRuntime.js',
    '../server/services/jobRuntimeTick.js',
    '../server/services/jobRuntimeStepExecution.js',
    '../server/services/jobRuntimeLifecycle.js',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
  const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  assert.match(runtimeSource, /`\/task\?job=\$\{encodeURIComponent\(job\.id\)\}`/)
  assert.doesNotMatch(runtimeSource, /`\/tasks\?job=/)
  assert.match(
    appSource,
    /path="\/tasks" element=\{<RequireAuth><RoutedTaskRunPanel \/><\/RequireAuth>\}/,
  )
})


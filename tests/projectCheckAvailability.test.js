import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runProjectCheckTool } from '../server/adapters/gitWorkbenchProjectCheck.js'
import { taskVerificationScopes } from '../server/services/loop/taskVerificationCheckScope.js'
import { observeTaskVerificationRepair, restoreTaskVerificationRepair, hasPendingTaskVerificationRepair } from '../server/services/loop/taskVerificationRepair.js'

test('an absent optional package check advertises available checks without running or poisoning verification state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-check-availability-'))
  const overrides = { WORKSPACE_ROOT: root, WORKSPACE_SHARED_TRUSTED: '1', WORKSPACE_SHELL_ENABLED: '1',
    WORKSPACE_GIT_ENABLED: '1', npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc') }
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))
  try {
    Object.assign(process.env, overrides)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }))
    const result = await runProjectCheckTool({ check: 'lint', cwd: '.' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PROJECT_CHECK_NOT_CONFIGURED')
    assert.equal(result.executed, false)
    assert.deepEqual(result.availableChecks, ['test'])
    assert.equal(fs.existsSync(path.join(root, 'npm-cache')), false, 'no npm process should start for an absent script')
    const call = { name: 'run_project_check', args: { check: 'lint', cwd: '.' } }
    assert.deepEqual(taskVerificationScopes(call, result), [])
    const state = restoreTaskVerificationRepair()
    observeTaskVerificationRepair(state, call, result)
    assert.equal(hasPendingTaskVerificationRepair(state), false)
    assert.equal(state.indeterminate.size, 0)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getRuntimeEnv,
  getWorkspaceRuntimeConfiguration,
  readRuntimeConfigFile,
  readRuntimeEnvFile,
  updateWorkspaceRuntimeConfiguration,
} from '../server/utils/runtimeEnv.js'

test('runtime env reads .env values and lets process variables override them', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-env-'))
  fs.writeFileSync(path.join(cwd, '.env'), [
    '# comment',
    'WORKSPACE_GIT_ENABLED=1',
    'QUOTED_VALUE="from file"',
    'EMPTY_VALUE=',
  ].join('\n'), 'utf8')

  assert.deepEqual(readRuntimeEnvFile(cwd), {
    WORKSPACE_GIT_ENABLED: '1',
    QUOTED_VALUE: 'from file',
    EMPTY_VALUE: '',
  })
  const runtime = getRuntimeEnv({ WORKSPACE_GIT_ENABLED: '0' }, { cwd })
  assert.equal(runtime.WORKSPACE_GIT_ENABLED, '0')
  assert.equal(runtime.QUOTED_VALUE, 'from file')
})

test('runtime config layers user, project, explicit, dotenv, then process env', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-runtime-layers-'))
  const dataDir = path.join(cwd, 'data')
  fs.mkdirSync(path.join(cwd, '.gugo'), { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ env: {
    LAYER_VALUE: 'user', USER_ONLY: true,
  } }))
  fs.writeFileSync(path.join(cwd, '.gugo', 'runtime.json'), JSON.stringify({
    LAYER_VALUE: 'project', PROJECT_ONLY: 4,
  }))
  fs.writeFileSync(path.join(cwd, 'local.json'), JSON.stringify({ env: {
    LAYER_VALUE: 'explicit', EXPLICIT_ONLY: 'yes',
  } }))
  fs.writeFileSync(path.join(cwd, '.env'), 'LAYER_VALUE=dotenv\nDOTENV_ONLY=1\n')

  const runtime = getRuntimeEnv({
    APP_DATA_DIR: dataDir,
    APP_CONFIG_PATH: 'local.json',
    LAYER_VALUE: 'process',
  }, { cwd })
  assert.equal(runtime.LAYER_VALUE, 'process')
  assert.equal(runtime.USER_ONLY, 'true')
  assert.equal(runtime.PROJECT_ONLY, '4')
  assert.equal(runtime.EXPLICIT_ONLY, 'yes')
  assert.equal(runtime.DOTENV_ONLY, '1')
})

test('runtime JSON rejects secrets and non-scalar values', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-runtime-invalid-'))
  const secretPath = path.join(cwd, 'secret.json')
  fs.writeFileSync(secretPath, JSON.stringify({ MODEL_API_KEY: 'sk-nope' }))
  assert.throws(() => readRuntimeConfigFile(secretPath), /sensitive runtime config key/)

  const objectPath = path.join(cwd, 'object.json')
  fs.writeFileSync(objectPath, JSON.stringify({ NESTED_VALUE: { enabled: true } }))
  assert.throws(() => readRuntimeConfigFile(objectPath), /must be a scalar/)
})

test('runtime env can disable cwd dotenv for packaged desktop isolation', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-desktop-env-'))
  fs.writeFileSync(path.join(cwd, '.env'), 'MODEL_PROVIDERS=deepseek,mimo\nMODEL_NAME=deepseek-chat\n')

  const runtime = getRuntimeEnv({ GUGO_LOAD_DOTENV: '0' }, { cwd })
  assert.equal(runtime.MODEL_PROVIDERS, undefined)
  assert.equal(runtime.MODEL_NAME, undefined)
})

test('workspace onboarding runtime switches persist atomically with completion metadata', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-workspace-onboarding-env-'))
  const dataDir = path.join(cwd, 'data')
  const keys = [
    'WORKSPACE_FS_ENABLED',
    'WORKSPACE_SHELL_ENABLED',
    'WORKSPACE_GIT_ENABLED',
    'WORKSPACE_GIT_MUTATION_ENABLED',
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const env = { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' }
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }

  try {
    const before = getWorkspaceRuntimeConfiguration({ cwd, env })
    const desired = {
      WORKSPACE_FS_ENABLED: before.features.WORKSPACE_FS_ENABLED.locked
        ? before.features.WORKSPACE_FS_ENABLED.enabled : true,
      WORKSPACE_SHELL_ENABLED: before.features.WORKSPACE_SHELL_ENABLED.locked
        ? before.features.WORKSPACE_SHELL_ENABLED.enabled : true,
      WORKSPACE_GIT_ENABLED: before.features.WORKSPACE_GIT_ENABLED.locked
        ? before.features.WORKSPACE_GIT_ENABLED.enabled : false,
      WORKSPACE_GIT_MUTATION_ENABLED: before.features.WORKSPACE_GIT_MUTATION_ENABLED.locked
        ? before.features.WORKSPACE_GIT_MUTATION_ENABLED.enabled : false,
    }
    const completedAt = 1_786_400_000_000
    const result = updateWorkspaceRuntimeConfiguration({
      cwd,
      env,
      features: desired,
      completedAt,
    })
    assert.equal(result.completedAt, completedAt)
    const filePath = path.join(dataDir, 'runtime.json')
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.deepEqual(saved.env, Object.fromEntries(
      Object.entries(desired).map(([key, value]) => [key, value ? '1' : '0']),
    ))
    assert.equal(saved.onboarding.completedAt, completedAt)
    assert.equal(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')), false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

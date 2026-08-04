import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { getRuntimeEnv, readRuntimeConfigFile, readRuntimeEnvFile } from '../server/utils/runtimeEnv.js'

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

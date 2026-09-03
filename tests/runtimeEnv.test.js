import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MAX_RUNTIME_CONFIG_BYTES,
  assertRuntimeStartupIdentityStable,
  getRuntimeEnv,
  getWorkspaceRuntimeConfiguration,
  readRuntimeConfigFile,
  readRuntimeConfigFileSnapshot,
  readRuntimeEnvFile,
  resolveRuntimeStartupEnvironment,
  updateWorkspaceRuntimeConfiguration,
} from '../server/utils/runtimeEnv.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const storageBootstrapFixture = path.join(testDir, 'fixtures', 'runtimeStorageBootstrap.mjs')
const runtimeEnvModuleUrl = pathToFileURL(path.join(testDir, '..', 'server', 'utils', 'runtimeEnv.js')).href

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

test('missing dotenv warning points to local BYOK settings and treats env as deployment defaults', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-missing-env-warning-'))
  const childEnv = { ...process.env }
  delete childEnv.MODEL_BASE_URL
  delete childEnv.MODEL_PROVIDERS
  try {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { readRuntimeEnvFile } = await import(${JSON.stringify(runtimeEnvModuleUrl)}); readRuntimeEnvFile(process.cwd())`,
    ], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: 10_000,
    })

    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /设置 → 模型/)
    assert.match(result.stderr, /本地 BYOK Provider/)
    assert.match(result.stderr, /MODEL_\* 环境变量仅用于部署默认配置/)
    assert.doesNotMatch(result.stderr, /只从系统环境变量读取/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('runtime config snapshot reads one bounded byte sequence and reports typed failures', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-runtime-snapshot-'))
  const validPath = path.join(cwd, 'valid.json')
  const invalidPath = path.join(cwd, 'invalid.json')
  const oversizedPath = path.join(cwd, 'oversized.json')
  const originalReadFileSync = fs.readFileSync
  try {
    fs.writeFileSync(validPath, JSON.stringify({ env: { FEATURE_FLAG: true }, metadata: 'kept' }))
    fs.writeFileSync(invalidPath, '{ invalid json')
    fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_RUNTIME_CONFIG_BYTES + 1, 0x20))

    let validReads = 0
    fs.readFileSync = function countedRead(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(validPath)) validReads += 1
      return originalReadFileSync.call(this, filePath, ...args)
    }
    const snapshot = readRuntimeConfigFileSnapshot(validPath)
    assert.equal(validReads, 1)
    assert.equal(snapshot.env.FEATURE_FLAG, 'true')
    assert.equal(snapshot.document.metadata, 'kept')
    assert.equal(snapshot.content.toString('utf8'), fs.readFileSync(validPath, 'utf8'))

    assert.throws(
      () => readRuntimeConfigFileSnapshot(invalidPath),
      (error) => error?.code === 'RUNTIME_CONFIG_FILE_INVALID'
        && error.statusCode === 422
        && error.retryable === false
        && error.sourcePath === invalidPath,
    )

    let oversizedReads = 0
    fs.readFileSync = function guardedRead(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(oversizedPath)) oversizedReads += 1
      return originalReadFileSync.call(this, filePath, ...args)
    }
    assert.throws(
      () => readRuntimeConfigFileSnapshot(oversizedPath),
      (error) => error?.code === 'RUNTIME_CONFIG_FILE_TOO_LARGE'
        && error.statusCode === 413
        && error.sourcePath === oversizedPath,
    )
    assert.equal(oversizedReads, 0)
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup resolution anchors relative storage to cwd and reads relocated user config', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-storage-resolution-'))
  const dataDir = path.join(cwd, 'relative-data')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(cwd, '.env'),
      'APP_DATA_DIR=relative-data\nARTIFACT_DIR=relative-artifacts\n',
      'utf8',
    )
    fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({
      env: { RELOCATED_USER_CONFIG: 'loaded' },
    }), 'utf8')

    const runtime = resolveRuntimeStartupEnvironment({ cwd, env: {} })
    assert.equal(runtime.APP_DATA_DIR, dataDir)
    assert.equal(runtime.APP_DB_PATH, path.join(dataDir, 'app.db'))
    assert.equal(runtime.ARTIFACT_DIR, path.join(cwd, 'relative-artifacts'))
    assert.equal(runtime.RELOCATED_USER_CONFIG, 'loaded')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup resolution discovers explicit config from the project layer and anchors its DB path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-explicit-resolution-'))
  try {
    fs.mkdirSync(path.join(cwd, '.gugo'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.gugo', 'runtime.json'), JSON.stringify({
      APP_CONFIG_PATH: 'deployment.json',
      APP_DATA_DIR: 'project-data',
    }), 'utf8')
    fs.writeFileSync(path.join(cwd, 'deployment.json'), JSON.stringify({ env: {
      APP_DB_PATH: 'sqlite/custom.db',
      EXPLICIT_STARTUP_MARKER: 'loaded',
    } }), 'utf8')

    const runtime = resolveRuntimeStartupEnvironment({
      cwd,
      env: { GUGO_LOAD_DOTENV: '0' },
    })
    assert.equal(runtime.APP_DATA_DIR, path.join(cwd, 'project-data'))
    assert.equal(runtime.APP_DB_PATH, path.join(cwd, 'sqlite', 'custom.db'))
    assert.equal(runtime.APP_CONFIG_PATH, path.join(cwd, 'deployment.json'))
    assert.equal(runtime.EXPLICIT_STARTUP_MARKER, 'loaded')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup resolution rejects an explicit config that selects a different config source', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-explicit-self-relocation-'))
  const explicitPath = path.join(cwd, 'deployment.json')
  try {
    fs.mkdirSync(path.join(cwd, '.gugo'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.gugo', 'runtime.json'), JSON.stringify({
      APP_CONFIG_PATH: 'deployment.json',
    }), 'utf8')
    fs.writeFileSync(explicitPath, JSON.stringify({ env: {
      APP_CONFIG_PATH: 'replacement.json',
    } }), 'utf8')
    fs.writeFileSync(path.join(cwd, 'replacement.json'), JSON.stringify({ env: {
      SHOULD_NOT_LOAD: 'replacement',
    } }), 'utf8')

    assert.throws(
      () => resolveRuntimeStartupEnvironment({
        cwd,
        env: { GUGO_LOAD_DOTENV: '0' },
      }),
      (error) => error?.code === 'RUNTIME_CONFIG_SELF_RELOCATION'
        && error.key === 'APP_CONFIG_PATH'
        && error.sourcePath === explicitPath
        && error.requestedPath === path.join(cwd, 'replacement.json'),
    )
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup resolution allows an explicit config to name its own canonical path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-explicit-stable-path-'))
  const explicitPath = path.join(cwd, 'deployment.json')
  try {
    fs.writeFileSync(explicitPath, JSON.stringify({ env: {
      APP_CONFIG_PATH: './deployment.json',
      EXPLICIT_STABLE_MARKER: 'loaded',
    } }), 'utf8')

    const runtime = resolveRuntimeStartupEnvironment({
      cwd,
      env: { GUGO_LOAD_DOTENV: '0', APP_CONFIG_PATH: explicitPath },
    })
    assert.equal(runtime.APP_CONFIG_PATH, explicitPath)
    assert.equal(runtime.EXPLICIT_STABLE_MARKER, 'loaded')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup identity guard rejects data, database, and config source changes', () => {
  const stable = Object.freeze({
    APP_DATA_DIR: 'D:\\runtime-data',
    APP_DB_PATH: 'D:\\runtime-data\\app.db',
    ARTIFACT_DIR: 'D:\\runtime-artifacts',
    APP_CONFIG_PATH: 'D:\\runtime-config.json',
  })
  assert.equal(assertRuntimeStartupIdentityStable(stable, { ...stable }), true)

  for (const key of ['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR', 'APP_CONFIG_PATH']) {
    assert.throws(
      () => assertRuntimeStartupIdentityStable(stable, {
        ...stable,
        [key]: `${stable[key]}.changed`,
      }),
      (error) => error?.code === 'RUNTIME_CONFIG_IDENTITY_CHANGED_DURING_PREFLIGHT'
        && error.retryable === false
        && error.key === key
        && error.before === stable[key]
        && error.after === `${stable[key]}.changed`,
    )
  }
})

test('startup resolution rejects a user runtime config that relocates its own source', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-self-relocation-'))
  const dataDir = path.join(cwd, 'data')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(cwd, '.env'), 'APP_DATA_DIR=data\n', 'utf8')
    for (const key of ['APP_DATA_DIR', 'APP_CONFIG_PATH']) {
      fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({
        env: { [key]: 'elsewhere' },
      }), 'utf8')
      assert.throws(
        () => resolveRuntimeStartupEnvironment({ cwd, env: {} }),
        (error) => error?.code === 'RUNTIME_CONFIG_SELF_RELOCATION'
          && error.message.includes(key),
      )
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup preflight creates SQLite under the cwd-relative dotenv data root', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-storage-preflight-'))
  try {
    fs.writeFileSync(
      path.join(cwd, '.env'),
      'APP_DATA_DIR=relative-data\nARTIFACT_DIR=relative-artifacts\n',
      'utf8',
    )
    const result = spawnSync(process.execPath, [storageBootstrapFixture], {
      cwd,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const expectedDbPath = path.join(cwd, 'relative-data', 'app.db')
    const expectedArtifactDir = path.join(cwd, 'relative-artifacts')
    const defaultDbPath = path.join(cwd, 'server-data', 'app.db')
    assert.equal(fs.existsSync(expectedDbPath), true)
    assert.equal(fs.existsSync(defaultDbPath), false)
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      appDataDir: path.join(cwd, 'relative-data'),
      appDbPath: expectedDbPath,
      artifactDir: expectedArtifactDir,
      importedArtifactDir: expectedArtifactDir,
    })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup preflight creates nested parents for a cwd-relative custom SQLite path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-relative-db-preflight-'))
  try {
    const expectedDataDir = path.join(cwd, 'data-root')
    const expectedDbPath = path.join(cwd, 'sqlite', 'nested', 'app.db')
    fs.writeFileSync(path.join(cwd, '.env'), [
      'APP_DATA_DIR=data-root',
      'APP_DB_PATH=sqlite/nested/app.db',
    ].join('\n'), 'utf8')

    const result = spawnSync(process.execPath, [storageBootstrapFixture], {
      cwd,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.existsSync(expectedDataDir), true)
    assert.equal(fs.existsSync(expectedDbPath), true)
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      appDataDir: expectedDataDir,
      appDbPath: expectedDbPath,
      artifactDir: path.join(cwd, '.artifacts'),
      importedArtifactDir: path.join(cwd, '.artifacts'),
    })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('startup preflight creates nested parents for an absolute custom SQLite path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-absolute-db-preflight-'))
  const cwd = path.join(root, 'project')
  const expectedDbPath = path.join(root, 'external-sqlite', 'nested', 'app.db')
  try {
    fs.mkdirSync(cwd, { recursive: true })
    const expectedDataDir = path.join(cwd, 'data-root')
    fs.writeFileSync(path.join(cwd, '.env'), [
      'APP_DATA_DIR=data-root',
      `APP_DB_PATH=${expectedDbPath}`,
    ].join('\n'), 'utf8')

    const result = spawnSync(process.execPath, [storageBootstrapFixture], {
      cwd,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.existsSync(expectedDataDir), true)
    assert.equal(fs.existsSync(expectedDbPath), true)
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      appDataDir: expectedDataDir,
      appDbPath: expectedDbPath,
      artifactDir: path.join(cwd, '.artifacts'),
      importedArtifactDir: path.join(cwd, '.artifacts'),
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { validateRuntimeStoragePath } from '../server/utils/runtimeStoragePath.js'
import { resolveRuntimeStartupEnvironment } from '../server/utils/runtimeEnv.js'

const dbModuleUrl = pathToFileURL(path.resolve('server/db.js')).href
const artifactStorageModuleUrl = pathToFileURL(path.resolve('server/services/artifactStorage.js')).href
const invalidLiterals = ['undefined', 'null', 'NaN', '[object Object]']
const windowsReservedDeviceNames = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]

test('runtime storage paths reject Win32 reserved device names in every segment', () => {
  const invalidPaths = [
    ...windowsReservedDeviceNames,
    'nul.db',
    'C:\\runtime\\COM1\\app.db',
    'relative/PRN.txt',
    'C:\\runtime\\AUX...   ',
    'C:LPT9.log',
  ]

  for (const value of invalidPaths) {
    assert.throws(
      () => validateRuntimeStoragePath(value, { key: 'APP_DB_PATH', platform: 'win32' }),
      (error) => error?.code === 'RUNTIME_STORAGE_PATH_INVALID'
        && error.retryable === false
        && error.key === 'APP_DB_PATH',
      value,
    )
  }
})

test('runtime storage paths preserve normal Windows paths and non-Windows device-like names', () => {
  const normalWindowsPaths = [
    'C:\\runtime\\app.db',
    'C:\\runtime\\COM10\\app.db',
    'C:\\runtime\\NUL-safe.db',
    'C:\\runtime\\CONSOLE\\app.db',
  ]
  for (const value of normalWindowsPaths) {
    assert.equal(validateRuntimeStoragePath(value, { platform: 'win32' }), value)
  }

  for (const value of ['/tmp/NUL', '/tmp/nul.db', '/tmp/COM1']) {
    assert.equal(validateRuntimeStoragePath(value, { platform: 'linux' }), value)
  }
})

test('runtime startup rejects coerced storage path literals before resolving them under cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-invalid-runtime-storage-'))
  try {
    for (const key of ['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR']) {
      for (const value of invalidLiterals) {
        assert.throws(
          () => resolveRuntimeStartupEnvironment({
            cwd,
            env: {
              GUGO_LOAD_DOTENV: '0',
              APP_DATA_DIR: key === 'APP_DATA_DIR' ? value : path.join(cwd, 'data'),
              ...(key === 'APP_DB_PATH' ? { APP_DB_PATH: value } : {}),
              ...(key === 'ARTIFACT_DIR' ? { ARTIFACT_DIR: value } : {}),
            },
          }),
          (error) => error?.code === 'RUNTIME_STORAGE_PATH_INVALID'
            && error.retryable === false
            && error.key === key
            && error.value === value,
        )
      }
    }
    for (const value of invalidLiterals) {
      assert.equal(fs.existsSync(path.join(cwd, value)), false)
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('direct artifact storage import rejects unsafe path literals without creating directories', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-invalid-artifact-path-'))
  try {
    const invalidArtifactPaths = process.platform === 'win32'
      ? [...invalidLiterals, 'NUL', 'nul.txt', 'COM1']
      : invalidLiterals
    const script = `
      const results = [];
      for (const [index, value] of ${JSON.stringify(invalidArtifactPaths)}.entries()) {
        process.env.ARTIFACT_DIR = value;
        try {
          await import(${JSON.stringify(artifactStorageModuleUrl)} + '?case=' + index);
          results.push({ value, imported: true });
        } catch (error) {
          results.push({ value, code: error.code, key: error.key });
        }
      }
      process.stdout.write(JSON.stringify(results));
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd,
      env: {
        ...process.env,
        GUGO_LOAD_DOTENV: '0',
        ARTIFACT_DIR: 'undefined',
      },
      encoding: 'utf8',
      timeout: 30_000,
    })

    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout), invalidArtifactPaths.map((value) => ({
      value,
      code: 'RUNTIME_STORAGE_PATH_INVALID',
      key: 'ARTIFACT_DIR',
    })))
    assert.deepEqual(fs.readdirSync(cwd), [])
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('direct database bootstrap rejects unsafe path literals without creating SQLite sidecars', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-invalid-db-path-'))
  try {
    const invalidDbPaths = process.platform === 'win32'
      ? [...invalidLiterals, 'NUL', 'nul.db', 'COM1']
      : invalidLiterals
    const script = `
      import { getDb } from ${JSON.stringify(dbModuleUrl)};
      const results = [];
      for (const value of ${JSON.stringify(invalidDbPaths)}) {
        process.env.APP_DB_PATH = value;
        try {
          getDb();
          results.push({ value, opened: true });
        } catch (error) {
          results.push({ value, code: error.code, key: error.key });
        }
      }
      process.stdout.write(JSON.stringify(results));
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd,
      env: {
        ...process.env,
        GUGO_LOAD_DOTENV: '0',
        APP_DATA_DIR: path.join(cwd, 'data'),
        APP_DB_PATH: 'undefined',
      },
      encoding: 'utf8',
      timeout: 30_000,
    })

    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout), invalidDbPaths.map((value) => ({
      value,
      code: 'RUNTIME_STORAGE_PATH_INVALID',
      key: 'APP_DB_PATH',
    })))
    for (const value of invalidLiterals) {
      for (const suffix of ['', '-wal', '-shm']) {
        assert.equal(fs.existsSync(path.join(cwd, `${value}${suffix}`)), false)
      }
    }
    assert.deepEqual(fs.readdirSync(cwd), [])
    assert.equal(fs.existsSync(path.join(cwd, 'data')), false)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

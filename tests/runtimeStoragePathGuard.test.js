import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { resolveRuntimeStartupEnvironment } from '../server/utils/runtimeEnv.js'

const dbModuleUrl = pathToFileURL(path.resolve('server/db.js')).href
const invalidLiterals = ['undefined', 'null', 'NaN', '[object Object]']

test('runtime startup rejects coerced storage path literals before resolving them under cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-invalid-runtime-storage-'))
  try {
    for (const key of ['APP_DATA_DIR', 'APP_DB_PATH']) {
      for (const value of invalidLiterals) {
        assert.throws(
          () => resolveRuntimeStartupEnvironment({
            cwd,
            env: {
              GUGO_LOAD_DOTENV: '0',
              APP_DATA_DIR: key === 'APP_DATA_DIR' ? value : path.join(cwd, 'data'),
              ...(key === 'APP_DB_PATH' ? { APP_DB_PATH: value } : {}),
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

test('direct database bootstrap rejects coerced path literals without creating SQLite sidecars', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-invalid-db-path-'))
  try {
    const script = `
      import { getDb } from ${JSON.stringify(dbModuleUrl)};
      const results = [];
      for (const value of ${JSON.stringify(invalidLiterals)}) {
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
    assert.deepEqual(JSON.parse(result.stdout), invalidLiterals.map((value) => ({
      value,
      code: 'RUNTIME_STORAGE_PATH_INVALID',
      key: 'APP_DB_PATH',
    })))
    for (const value of invalidLiterals) {
      for (const suffix of ['', '-wal', '-shm']) {
        assert.equal(fs.existsSync(path.join(cwd, `${value}${suffix}`)), false)
      }
    }
    assert.equal(fs.existsSync(path.join(cwd, 'data')), false)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

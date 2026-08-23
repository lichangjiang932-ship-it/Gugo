import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.dirname(testDir)
const fixturePath = path.join(testDir, 'fixtures', 'evolutionConfigStartupBarrier.mjs')
const distDir = path.join(repoDir, 'dist')
const distIndexPath = path.join(distDir, 'index.html')
const STATIC_ENTRY_FIXTURE = '<!doctype html><html><body><div id="root"></div></body></html>\n'

function ensureStaticEntryFixture() {
  const createdDistDir = !fs.existsSync(distDir)
  fs.mkdirSync(distDir, { recursive: true })
  let createdIndex = false
  try {
    fs.writeFileSync(distIndexPath, STATIC_ENTRY_FIXTURE, { encoding: 'utf8', flag: 'wx' })
    createdIndex = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return () => {
    if (createdIndex) {
      try {
        if (fs.readFileSync(distIndexPath, 'utf8') === STATIC_ENTRY_FIXTURE) {
          fs.rmSync(distIndexPath, { force: true })
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (createdDistDir) {
      try {
        fs.rmdirSync(distDir)
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error
      }
    }
  }
}

function fixtureEnv(dataDir) {
  const env = {
    ...process.env,
    APP_DATA_DIR: dataDir,
    APP_DB_PATH: path.join(dataDir, 'app.db'),
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
    NODE_ENV: 'production',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: '0',
  }
  delete env.MODEL_TEMPERATURE
  return env
}

function runFixture(mode, dataDir, timeout = 60_000) {
  const cleanupStaticEntry = mode === 'start' ? ensureStaticEntryFixture() : () => {}
  try {
    return spawnSync(process.execPath, [fixturePath, mode], {
      cwd: repoDir,
      env: fixtureEnv(dataDir),
      encoding: 'utf8',
      timeout,
    })
  } finally {
    cleanupStaticEntry()
  }
}

function prepareInterruptedApply(dataDir) {
  const prepared = runFixture('prepare', dataDir)
  assert.equal(prepared.error, undefined, prepared.error?.message)
  assert.equal(prepared.status, 86, `${prepared.stdout}\n${prepared.stderr}`)
  const configPath = path.join(dataDir, 'runtime.json')
  const journalPath = path.join(dataDir, '.runtime.json.evolution-config.pending.json')
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).env.MODEL_TEMPERATURE, '0.2')
  assert.equal(fs.existsSync(journalPath), true)
  return { configPath, journalPath }
}

function startupResult(output) {
  const marker = String(output || '').split(/\r?\n/u).find((line) => (
    line.startsWith('EVOLUTION_CONFIG_STARTUP_RESULT ')
  ))
  assert.ok(marker, `startup result marker was missing:\n${output}`)
  return JSON.parse(marker.slice('EVOLUTION_CONFIG_STARTUP_RESULT '.length))
}

function preflightResult(output) {
  const marker = String(output || '').split(/\r?\n/u).find((line) => (
    line.startsWith('EVOLUTION_CONFIG_PREFLIGHT_RESULT ')
  ))
  assert.ok(marker, `preflight result marker was missing:\n${output}`)
  return JSON.parse(marker.slice('EVOLUTION_CONFIG_PREFLIGHT_RESULT '.length))
}

test('startup preflight completes database migration without a pending config journal', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-startup-empty-'))
  try {
    const preflight = runFixture('preflight-empty', dataDir)
    assert.equal(preflight.error, undefined, preflight.error?.message)
    assert.equal(preflight.status, 0, `${preflight.stdout}\n${preflight.stderr}`)
    assert.deepEqual(preflightResult(preflight.stdout), {
      beforeDbExists: false,
      afterDbExists: true,
      recoveryStatus: 'none',
    })
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('full server startup reconciles an after_config_replaced journal before runtime bootstrap', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-startup-recovery-'))
  try {
    const { journalPath } = prepareInterruptedApply(dataDir)
    const started = runFixture('start', dataDir, 90_000)
    assert.equal(started.error, undefined, started.error?.message)
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`)

    const result = startupResult(started.stdout)
    assert.deepEqual(result.synchronousBarrier, {
      auditCount: 1,
      journalExists: false,
      repeatedRecoveryStatus: 'none',
      runtimeTemperature: '0.2',
      runtimeState: 'starting',
    })
    assert.equal(result.readyState.auditCount, 1)
    assert.equal(result.readyState.journalExists, false)
    assert.equal(result.readyState.runtimeState, 'ready')
    assert.equal(fs.existsSync(journalPath), false)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('full server startup fails closed and preserves an invalid pending config journal', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-startup-invalid-'))
  try {
    const { journalPath } = prepareInterruptedApply(dataDir)
    fs.writeFileSync(journalPath, '{"schemaVersion":1,"state":"corrupt"}\n', 'utf8')

    const started = runFixture('start', dataDir)
    assert.equal(started.error, undefined, started.error?.message)
    assert.notEqual(started.status, 0, `${started.stdout}\n${started.stderr}`)
    assert.doesNotMatch(started.stdout, /EVOLUTION_CONFIG_STARTUP_RESULT/u)
    assert.match(started.stderr, /pending config change journal is invalid/iu)
    assert.equal(fs.existsSync(journalPath), true)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

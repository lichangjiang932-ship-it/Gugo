import '../../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import test from 'node:test'
import { CLI_PATH, NETWORK_GUARD, MODEL_NAME, isolatedEnvironment, seedProvider } from './helpers/artifactCompletionHarness.js'

const ROOT_PREFIX = 'gugo-cli-model-not-loaded-'
const NOT_LOADED_MESSAGE = 'No models loaded. Please load a model in the developer page or use the lms load command.'

function runCli(t, paths, env, providerId, format) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', NETWORK_GUARD, CLI_PATH, 'run',
      'Reply with only: isolated model availability fixture.', '--provider', providerId,
      '--model', MODEL_NAME, '--cwd', paths.workspace, '--output', format], {
      cwd: paths.workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr, timedOut })
    })
  })
}

async function fixture(t) {
  const tempParent = realpathSync(tmpdir())
  const root = mkdtempSync(join(tempParent, ROOT_PREFIX))
  const paths = Object.fromEntries(['workspace', 'data', 'config', 'artifacts', 'tokenHome', 'temp', 'output']
    .map((name) => [name, join(root, name)]))
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  Object.assign(paths, { root, database: join(paths.data, 'app.db') })
  writeFileSync(join(paths.config, 'runtime.json'), JSON.stringify({ env: {} }), 'utf8')
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    req.once('end', () => {
      requests.push({ url: req.url, body: JSON.parse(raw) })
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: NOT_LOADED_MESSAGE }))
    })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(dirname(realpathSync(root)), tempParent)
    assert.ok(basename(root).startsWith(ROOT_PREFIX))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const env = { ...isolatedEnvironment(paths, port), WORKSPACE_SHELL_ENABLED: '0' }
  const providerId = seedProvider(env, paths, port)
  return { requests, run: (format) => runCli(t, paths, env, providerId, format), snapshot: () => {
    const db = new Database(paths.database, { readonly: true, fileMustExist: true })
    try {
      return db.prepare('SELECT type, sequence, payload_json FROM turn_events ORDER BY sequence').all()
        .map((row) => ({ type: row.type, sequence: row.sequence, payload: JSON.parse(row.payload_json) }))
    } finally { db.close() }
  } }
}

for (const format of ['text', 'jsonl']) {
  test(`real CLI ${format} preserves an actionable unloaded-model failure in the durable terminal`, { timeout: 60_000 }, async (t) => {
    const harness = await fixture(t)
    const run = await harness.run(format)
    const events = harness.snapshot()
    const failure = events.find((event) => event.type === 'turn.failed')
    const diagnosis = JSON.stringify({ status: run.status, timedOut: run.timedOut,
      stderr: run.stderr, failure, requests: harness.requests.length })
    assert.equal(run.timedOut, false, diagnosis)
    assert.equal(run.status, 1, diagnosis)
    assert.equal(harness.requests.length, 1, 'the explicit HTTP 400 rejection must not trigger retries')
    assert.equal(harness.requests[0].body.model, MODEL_NAME)
    assert.equal(harness.requests[0].body.stream, true)
    assert.equal(events.some((event) => ['turn.blocked', 'turn.interrupted', 'turn.completed',
      'tool.started', 'tool.completed', 'approval.required'].includes(event.type)), false, diagnosis)
    assert.equal(failure?.payload.code, 'MODEL_NOT_LOADED', diagnosis)
    assert.equal(failure.payload.error.code, 'MODEL_NOT_LOADED')
    assert.equal(failure.payload.error.status, 400)
    assert.equal(failure.payload.error.retryable, false)
    assert.equal(failure.payload.error.modelRequestDiagnostics, undefined)
    assert.equal(failure.payload.error.message, undefined, 'raw provider prose remains outside terminal records')
    if (format === 'text') {
      assert.equal(run.stdout, '', 'failed turns cannot appear as successful pipeline output')
      assert.match(run.stderr, /MODEL_NOT_LOADED/)
      assert.match(run.stderr, /No model is loaded/i)
      assert.match(run.stderr, /lms load/)
    } else {
      const streamed = run.stdout.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line))
      assert.deepEqual(streamed.find((event) => event.type === 'turn.failed')?.payload, failure.payload)
    }
  })
}

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const CLI_PATH = fileURLToPath(new URL('../../../bin/yma-cli.js', import.meta.url))
const NETWORK_GUARD = new URL('./artifactCompletionNetworkGuard.mjs', import.meta.url).href
const ROOT_PREFIX = 'gugo-cli-model-progress-'
const MODEL_NAME = 'gpt-cli-progress-e2e'
export const MODEL_PROGRESS_TIMEOUT_MS = 2400
export const PROGRESS_TOOL_CALL_ID = 'cli_progress_read_once'
export const PROGRESS_SOURCE_TEXT = 'CLI_PROGRESS_CONTENT_VERIFIED_FROM_DISK'

function isolatedEnvironment(paths, port) {
  const inherited = {}
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SYSTEMDRIVE', 'LANG', 'LC_ALL']) {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    if (key) inherited[name] = process.env[key]
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path')
  return {
    ...inherited, PATH: [dirname(process.execPath), process.env[pathKey] || ''].join(delimiter),
    TEMP: paths.temp, TMP: paths.temp, TMPDIR: paths.temp,
    HOME: paths.tokenHome, USERPROFILE: paths.tokenHome,
    APPDATA: join(paths.tokenHome, 'roaming'), LOCALAPPDATA: join(paths.tokenHome, 'local'),
    XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
    APP_DATA_DIR: paths.data, APP_DB_PATH: paths.database,
    APP_CONFIG_PATH: join(paths.config, 'runtime.json'), ARTIFACT_DIR: paths.artifacts,
    WORKSPACE_ROOT: paths.workspace, WORKSPACE_FS_ENABLED: '1', WORKSPACE_SHELL_ENABLED: '0',
    WORKSPACE_SHARED_TRUSTED: '1', GUGO_SHELL_NETWORK_MODE: 'deny',
    YMA_TEST_DEFAULT_OUTPUT_DIR: paths.output, GUGO_LOAD_DOTENV: '0', AUTH_MODE: 'local',
    MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_API_KEY: '', MODEL_PROVIDERS: '',
    MODEL_FIRST_TOKEN_TIMEOUT_MS: String(MODEL_PROGRESS_TIMEOUT_MS), MODEL_IDLE_TIMEOUT_MS: String(MODEL_PROGRESS_TIMEOUT_MS),
    JOB_MAX_ITERS: '8', GUGO_CLI_TEST_PROVIDER_PORT: String(port),
    NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
  }
}

function seedProvider(env, paths, port) {
  const moduleUrl = (relative) => new URL(`../../../${relative}`, import.meta.url).href
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(moduleUrl('server/adapters/authAccount.js'))})
    const { upsertModelProvider, recordModelProviderReadiness } = await import(${JSON.stringify(moduleUrl('server/services/modelProviderStore.js'))})
    const { closeDb } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    try {
      const auth = bootstrapAuth({ env: process.env })
      const provider = upsertModelProvider({ userId: auth.user.id, provider: {
        key: 'cli-progress-fixture', label: 'Local streaming progress fixture',
        baseUrl: ${JSON.stringify(`http://127.0.0.1:${port}/v1`)}, apiKey: '',
        models: [${JSON.stringify(MODEL_NAME)}], defaultModel: ${JSON.stringify(MODEL_NAME)}, enabled: true, isDefault: true,
      } })
      recordModelProviderReadiness({ userId: auth.user.id, id: provider.id,
        modelName: ${JSON.stringify(MODEL_NAME)}, expectedConfigRevision: provider.configRevision,
        readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
      })
      process.stdout.write(provider.id)
    } finally { closeDb() }
  `
  const seeded = spawnSync(process.execPath, ['--import', NETWORK_GUARD, '--input-type=module', '--eval', script], {
    cwd: paths.workspace, env, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  })
  assert.equal(seeded.status, 0, `isolated provider seed failed: ${seeded.stderr}`)
  assert.match(seeded.stdout.trim(), /^[a-zA-Z0-9-]+$/u)
  return seeded.stdout.trim()
}

function readSnapshot(paths) {
  assert.equal(resolve(paths.database), join(paths.root, 'data', 'app.db'))
  const db = new Database(paths.database, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    const events = db.prepare('SELECT type, sequence, session_id, turn_id, payload_json, created_at FROM turn_events ORDER BY sequence').all()
      .map((row) => ({ type: row.type, sequence: row.sequence, sessionId: row.session_id, turnId: row.turn_id,
        payload: JSON.parse(row.payload_json), createdAt: row.created_at }))
    const checkpoint = db.prepare('SELECT state_json FROM turn_checkpoints ORDER BY updated_at DESC LIMIT 1').get()
    return { events, checkpoint: checkpoint ? JSON.parse(checkpoint.state_json) : null }
  } finally { db.close() }
}

function writeFrame(res, delta, finishReason = null) {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta,
    ...(finishReason ? { finish_reason: finishReason } : {}) }] })}\n\n`)
}

function createProvider(paths, scenario) {
  const state = { requests: [], failures: [], sentChunks: [], memoryRequests: 0, mainRequests: 0,
    beforeTerminal: null, terminalSentAt: null, closedAt: null, keepalives: 0, terminalBodies: [] }
  const timers = new Set()
  const schedule = (callback, delay = 400) => {
    const timer = setTimeout(() => { timers.delete(timer); callback() }, delay)
    timers.add(timer)
    return timer
  }
  const startStream = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.flushHeaders()
  }
  const finishStream = (res, finishReason = null) => {
    if (finishReason) writeFrame(res, {}, finishReason)
    if (scenario !== 'done_open') { res.end('data: [DONE]\n\n'); return }
    const observed = { terminalAt: Date.now(), closedAt: null, forcedClose: false }
    state.terminalBodies.push(observed)
    const guard = schedule(() => {
      if (res.destroyed || res.writableEnded) return
      observed.forcedClose = true
      res.end()
    }, 4000)
    res.once('close', () => { observed.closedAt = Date.now(); clearTimeout(guard); timers.delete(guard) })
    res.write('data: [DONE]\n\n')
    const keepOpen = () => {
      if (res.destroyed || res.writableEnded) return
      res.write(': post-terminal keepalive\n\n')
      schedule(keepOpen, 100)
    }
    keepOpen()
  }
  const streamArguments = (res) => {
    const serialized = JSON.stringify({ path: basename(paths.source) })
    let index = 0
    const send = () => {
      if (res.destroyed || res.writableEnded) return
      if (index === 9) {
        state.beforeTerminal = readSnapshot(paths)
        state.terminalSentAt = Date.now()
        finishStream(res, 'tool_calls')
        return
      }
      const partial = serialized.slice(Math.floor(index * serialized.length / 9), Math.floor((index + 1) * serialized.length / 9))
      state.sentChunks.push({ sentAt: Date.now(), chars: Math.floor((index + 1) * serialized.length / 9) })
      writeFrame(res, { tool_calls: [{ index: 0, ...(index === 0 ? { id: PROGRESS_TOOL_CALL_ID, type: 'function' } : {}),
        function: { ...(index === 0 ? { name: 'read_file' } : {}), arguments: partial } }] })
      index += 1
      schedule(send)
    }
    startStream(res)
    send()
  }
  const keepaliveOnly = (res) => {
    startStream(res)
    writeFrame(res, { role: 'assistant' })
    const send = () => {
      if (res.destroyed || res.writableEnded) return
      state.keepalives += 1
      res.write(': keepalive\n\ndata:\n\n')
      schedule(send, 100)
    }
    send()
  }
  const server = createServer((req, res) => {
    res.once('close', () => { state.closedAt = Date.now() })
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    req.once('end', () => {
      try {
        assert.equal(req.url, '/v1/chat/completions')
        const body = JSON.parse(raw)
        state.requests.push({ receivedAt: Date.now(), body })
        if (body.messages?.some((message) => message.role === 'system'
          && String(message.content).startsWith('Extract durable cross-session memories from this completed chat turn.'))) {
          assert.notEqual(scenario, 'keepalive')
          state.memoryRequests += 1
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"memories":[]}' }, finish_reason: 'stop' }] }))
          return
        }
        state.mainRequests += 1
        assert.equal(body.stream, true, 'the real CLI must request SSE, not a non-stream substitute')
        assert.equal(body.model, MODEL_NAME)
        if (scenario === 'keepalive') {
          assert.equal(state.mainRequests, 1, 'ambiguous requests cannot be automatically replayed')
          keepaliveOnly(res)
        } else if (state.mainRequests === 1) {
          assert.ok(body.tools?.some((entry) => entry.function?.name === 'read_file'))
          streamArguments(res)
        } else {
          assert.equal(state.mainRequests, 2, 'one read and one evidence-backed final response are sufficient')
          const resultMessage = body.messages?.find((message) => message.role === 'tool' && message.tool_call_id === PROGRESS_TOOL_CALL_ID)
          assert.ok(resultMessage, 'the provider must see the actual tool outcome before answering')
          const result = JSON.parse(resultMessage.content)
          assert.equal(result.ok, true)
          assert.ok(JSON.stringify(result).includes(PROGRESS_SOURCE_TEXT), 'file contents must come from the real executor')
          startStream(res)
          writeFrame(res, { content: `The file contains ${PROGRESS_SOURCE_TEXT}.` })
          finishStream(res, scenario === 'done_open' ? null : 'stop')
        }
      } catch (error) {
        state.failures.push(error.stack || error.message)
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: error.message } }))
      }
    })
  })
  return { state, server, dispose() { for (const timer of timers) clearTimeout(timer); timers.clear() } }
}

function runProcess(t, paths, env, providerId) {
  return new Promise((resolveRun, reject) => {
    const argv = ['--import', NETWORK_GUARD, CLI_PATH, 'run',
      `Read ${basename(paths.source)} and report its exact text. Do not create or edit any files.`,
      '--mode', 'bypass', '--cwd', paths.workspace, '--output', 'jsonl', '--provider', providerId, '--model', MODEL_NAME]
    const startedAt = Date.now()
    const child = spawn(process.execPath, argv, { cwd: paths.workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 25_000)
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      try {
        const events = stdout.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line))
        resolveRun({ status, signal, timedOut, events, stderr, argv, startedAt, closedAt: Date.now() })
      } catch (error) { reject(error) }
    })
    child.stdin.end()
  })
}

export async function createModelProgressHarness(t, scenario) {
  assert.ok(['arguments', 'keepalive', 'done_open'].includes(scenario))
  const tempParent = realpathSync(tmpdir())
  const root = mkdtempSync(join(tempParent, ROOT_PREFIX))
  const paths = Object.fromEntries(['workspace', 'data', 'config', 'artifacts', 'tokenHome', 'temp', 'output']
    .map((name) => [name, join(root, name)]))
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  Object.assign(paths, { root, database: join(paths.data, 'app.db'), source: join(paths.workspace, 'progress-source.txt') })
  writeFileSync(join(paths.config, 'runtime.json'), JSON.stringify({ env: {} }), 'utf8')
  writeFileSync(paths.source, PROGRESS_SOURCE_TEXT, 'utf8')
  const provider = createProvider(paths, scenario)
  t.after(async () => {
    provider.dispose()
    provider.server.closeAllConnections()
    await new Promise((resolveClose) => provider.server.close(resolveClose))
    assert.equal(dirname(realpathSync(root)), tempParent)
    assert.ok(basename(root).startsWith(ROOT_PREFIX))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  await new Promise((resolveListen, reject) => {
    provider.server.once('error', reject)
    provider.server.listen(0, '127.0.0.1', resolveListen)
  })
  const env = isolatedEnvironment(paths, provider.server.address().port)
  const providerId = seedProvider(env, paths, provider.server.address().port)
  return { paths, provider: provider.state,
    run: () => runProcess(t, paths, env, providerId), snapshot: () => readSnapshot(paths) }
}

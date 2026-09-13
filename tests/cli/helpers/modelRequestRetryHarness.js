import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CLI_PATH, NETWORK_GUARD, MODEL_NAME, isolatedEnvironment } from './artifactCompletionHarness.js'

export const RETRY_OUTPUT_TEXT = 'CLI_MODEL_RETRY_OUTPUT_VERIFIED_EXACTLY_ONCE'
export const RETRY_FINAL_TEXT = 'CLI_MODEL_RETRY_TASK_COMPLETED'
export const RETRY_WRITE_ID = 'cli_model_retry_write_once'
export const RETRY_READ_ID = 'cli_model_retry_read_once'
export const RETRY_DELIVER_ID = 'cli_model_retry_deliver_once'
export const RETRY_PARTIAL_ID = 'cli_model_retry_unfinished_call'
export const RETRY_IDLE_MS = 1200
const ROOT_PREFIX = 'gugo-cli-model-retry-'
const SCENARIOS = new Set(['healthy', 'grace', 'http_429', 'http_503', 'http_408', 'partial_rst', 'partial_idle', 'malformed_stream', 'cancel'])

async function seedIsolatedProvider(t, paths, env, port) {
  const moduleUrl = (name) => new URL(`../../../server/${name}`, import.meta.url).href
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(moduleUrl('adapters/authAccount.js'))})
    const { upsertModelProvider, recordModelProviderReadiness } = await import(${JSON.stringify(moduleUrl('services/modelProviderStore.js'))})
    const { closeDb } = await import(${JSON.stringify(moduleUrl('db.js'))})
    try {
      const auth = bootstrapAuth({ env: process.env })
      const provider = upsertModelProvider({ userId: auth.user.id, provider: {
        key: 'cli-model-retry-fixture', label: 'Local model retry fixture', baseUrl: ${JSON.stringify(`http://127.0.0.1:${port}/v1`)},
        apiKey: '', models: [${JSON.stringify(MODEL_NAME)}], defaultModel: ${JSON.stringify(MODEL_NAME)}, enabled: true, isDefault: true,
      } })
      recordModelProviderReadiness({ userId: auth.user.id, id: provider.id, modelName: ${JSON.stringify(MODEL_NAME)},
        expectedConfigRevision: provider.configRevision, readiness: { chat: true, tools: true, agent: true, mode: 'agent' } })
      process.stdout.write(provider.id)
    } finally { closeDb() }
  `
  return new Promise((resolveSeed, reject) => {
    const child = spawn(process.execPath, ['--import', NETWORK_GUARD, '--input-type=module', '--eval', script], {
      cwd: paths.workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const guard = setTimeout(() => child.kill('SIGKILL'), 40_000)
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(guard); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(guard)
      try {
        assert.equal(status, 0, `isolated provider seed failed (${signal || status}): ${stderr.slice(-2000)}`)
        assert.match(stdout.trim(), /^[a-zA-Z0-9-]+$/u)
        resolveSeed(stdout.trim())
      } catch (error) { reject(error) }
    })
  })
}

function snapshot(paths) {
  assert.equal(resolve(paths.database), join(paths.root, 'data', 'app.db'))
  const db = new DatabaseSync(paths.database, { readOnly: true })
  try {
    const events = db.prepare('SELECT type, sequence, session_id, turn_id, payload_json FROM turn_events ORDER BY sequence').all()
      .map((row) => ({ type: row.type, sequence: row.sequence, sessionId: row.session_id, turnId: row.turn_id,
        payload: JSON.parse(row.payload_json) }))
    const checkpoint = db.prepare('SELECT state_json FROM turn_checkpoints ORDER BY updated_at DESC LIMIT 1').get()
    const effects = db.prepare("SELECT tool_call_id, tool_name, status, args_digest FROM side_effect_executions WHERE effect_kind = 'tool' ORDER BY prepared_at, tool_call_id").all()
    return { events, checkpoint: checkpoint ? JSON.parse(checkpoint.state_json) : null, effects }
  } finally { db.close() }
}

function resultMessages(body) {
  const names = new Map((body.messages || []).flatMap((message) => (message.tool_calls || [])
    .map((call) => [call.id, call.function?.name])))
  return (body.messages || []).flatMap((message) => {
    if (message.role !== 'tool') return []
    try { return [{ message: { ...message, name: message.name || names.get(message.tool_call_id) }, result: JSON.parse(message.content) }] } catch { return [] }
  })
}

function frame(res, delta, finishReason = null) {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] })}\n\n`)
}

function startStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.flushHeaders()
}

function sendTool(res, id, name, args) {
  startStream(res)
  frame(res, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  frame(res, {}, 'tool_calls')
  res.end('data: [DONE]\n\n')
}

function sendFinal(res) {
  startStream(res)
  frame(res, { content: RETRY_FINAL_TEXT })
  frame(res, {}, 'stop')
  res.end('data: [DONE]\n\n')
}

function providerFor(paths, scenario, idleMs) {
  const timers = new Set()
  const state = { requests: [], mainRequests: [], memoryRequests: 0, failures: [], faults: [],
    writeIssued: 0, readIssued: 0, deliveryIssued: 0, onPartial: null, grace: null }
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback() }, delay)
    timers.add(timer)
    return timer
  }
  const unfinished = (res, kind) => {
    const record = { requestIndex: state.mainRequests.length, kind, beforeFault: null, closedAt: null }
    state.faults.push(record)
    startStream(res)
    frame(res, { reasoning_content: 'Reasoning about the authorized output. '.repeat(12).slice(0, 442) })
    const args = JSON.stringify({ path: basename(paths.partial), content: 'UNFINISHED_ARGUMENTS_MUST_NOT_EXECUTE_'.repeat(420) })
    frame(res, { tool_calls: [{ index: 0, id: RETRY_PARTIAL_ID, type: 'function', function: { name: 'write_file', arguments: args.slice(0, 13304) } }] })
    res.once('close', () => { record.closedAt = Date.now() })
    schedule(() => {
      if (res.destroyed || res.writableEnded) return
      record.beforeFault = snapshot(paths)
      record.partialFileExists = existsSync(paths.partial)
      state.onPartial?.()
      if (kind === 'rst') {
        if (typeof res.socket?.resetAndDestroy === 'function') res.socket.resetAndDestroy()
        else res.destroy()
      } else {
        const keepalive = () => {
          if (res.destroyed || res.writableEnded) return
          res.write(': non-semantic keepalive\n\n')
          schedule(keepalive, 100)
        }
        keepalive()
      }
    }, 180)
  }
  const pausedArguments = (res) => {
    const args = JSON.stringify({ path: basename(paths.target), content: RETRY_OUTPUT_TEXT })
    const split = Math.floor(args.length * 0.7)
    const observed = { chunks: [], beforeTerminal: null, terminalAt: null, closedAt: null }
    state.grace = observed
    state.writeIssued += 1
    startStream(res)
    observed.chunks.push(Date.now())
    frame(res, { tool_calls: [{ index: 0, id: RETRY_WRITE_ID, type: 'function', function: { name: 'write_file', arguments: args.slice(0, 10) } }] })
    res.once('close', () => { observed.closedAt = Date.now() })
    schedule(() => {
      if (res.destroyed || res.writableEnded) return
      observed.chunks.push(Date.now())
      frame(res, { tool_calls: [{ index: 0, function: { arguments: args.slice(10, split) } }] })
      schedule(() => {
        if (res.destroyed || res.writableEnded) return
        observed.beforeTerminal = snapshot(paths)
        observed.terminalAt = Date.now()
        frame(res, { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] })
        frame(res, {}, 'tool_calls')
        res.end('data: [DONE]\n\n')
      }, idleMs + 600)
    }, 100)
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    req.once('end', () => {
      try {
        assert.equal(req.url, '/v1/chat/completions')
        assert.ok(raw.length < 2_000_000, 'fixture requests remain bounded')
        const body = JSON.parse(raw)
        state.requests.push({ receivedAt: Date.now(), body })
        if (body.messages?.some((message) => message.role === 'system'
          && String(message.content).startsWith('Extract durable cross-session memories from this completed chat turn.'))) {
          state.memoryRequests += 1
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"memories":[]}' }, finish_reason: 'stop' }] }))
          return
        }
        state.mainRequests.push({ receivedAt: Date.now(), body })
        assert.equal(body.model, MODEL_NAME)
        assert.equal(body.stream, true)
        assert.ok(state.mainRequests.length <= 12, 'model retry must be bounded')
        const outcomes = resultMessages(body)
        const write = outcomes.find(({ message, result }) => message.tool_call_id === RETRY_WRITE_ID && result.ok === true)
        const read = outcomes.find(({ message, result }) => message.name === 'read_file' && result.ok === true && result.content === RETRY_OUTPUT_TEXT)
        const delivered = outcomes.find(({ message, result }) => message.tool_call_id === RETRY_DELIVER_ID && result.ok === true)
        const first = state.mainRequests.length === 1
        if ((scenario === 'http_429' && first) || ['http_503', 'http_408'].includes(scenario)) {
          const status = Number(scenario.slice(5))
          res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '0' })
          res.end(JSON.stringify({ error: { message: status === 429 ? 'fixture rate limit rejection' : 'fixture upstream outcome uncertain',
            type: status === 429 ? 'rate_limit_error' : 'server_error', code: status === 429 ? 'rate_limit_exceeded' : 'upstream_error' } }))
        } else if (scenario === 'grace' && first) {
          pausedArguments(res)
        } else if (scenario === 'malformed_stream') {
          startStream(res)
          res.end('data: {malformed upstream frame}\n\n')
        } else if (scenario === 'cancel' || (first && ['partial_rst', 'partial_idle'].includes(scenario))) {
          unfinished(res, ['partial_idle', 'cancel'].includes(scenario) ? 'idle' : 'rst')
        } else if (!write) {
          assert.equal(state.writeIssued, 0, 'a completed write must remain available after model recovery')
          state.writeIssued += 1
          assert.ok(body.tools?.some((tool) => tool.function?.name === 'write_file'))
          sendTool(res, RETRY_WRITE_ID, 'write_file', { path: basename(paths.target), content: RETRY_OUTPUT_TEXT })
        } else if (!read) {
          assert.equal(state.readIssued, 0, 'the original read result must survive model recovery')
          state.readIssued += 1
          sendTool(res, RETRY_READ_ID, 'read_file', { path: basename(paths.target) })
        } else if (!delivered) {
          const artifactIds = [...new Set(outcomes.flatMap(({ result }) => result.ok === true
            ? [result.artifactId, ...(result.artifactIds || []), ...(result.artifacts || []).map((artifact) => artifact.id)].filter(Boolean) : []))]
          assert.ok(artifactIds.length, 'delivery must use the actual host artifact receipt')
          assert.equal(state.deliveryIssued, 0, 'delivery receipt must survive subsequent model recovery')
          state.deliveryIssued += 1
          sendTool(res, RETRY_DELIVER_ID, 'set_deliverables', { artifact_ids: artifactIds })
        } else {
          assert.equal(readFileSync(paths.target, 'utf8'), RETRY_OUTPUT_TEXT)
          sendFinal(res)
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

function runProcess(t, paths, env, providerId, provider, { timeoutMs, cancelOnPartial = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const signalBridge = 'data:text/javascript,' + encodeURIComponent('process.on("message",value=>{if(value==="cancel-cli-fixture"){process.emit("SIGINT");process.disconnect()}})')
    const argv = ['--import', NETWORK_GUARD, ...(cancelOnPartial ? ['--import', signalBridge] : []), CLI_PATH, 'run',
        `Create ${basename(paths.target)} in the current workspace containing exactly ${RETRY_OUTPUT_TEXT}. Then reopen it with read_file, verify its text and report ${RETRY_FINAL_TEXT}.`,
        '--mode', 'bypass', '--provider', providerId, '--model', MODEL_NAME,
      '--cwd', paths.workspace, '--output', 'jsonl', ...(timeoutMs ? ['--timeout', String(timeoutMs)] : [])]
    const child = spawn(process.execPath, argv, { cwd: paths.workspace, env, windowsHide: true,
      stdio: cancelOnPartial ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const startedAt = Date.now()
    const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
    if (cancelOnPartial) provider.onPartial = () => {
      if (child.connected) child.send('cancel-cli-fixture')
      provider.onPartial = null
    }
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(guard); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(guard)
      try {
        resolveRun({ status, signal, timedOut, stderr, argv, startedAt, closedAt: Date.now(),
          events: stdout.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line)) })
      } catch (error) { reject(error) }
    })
    child.stdin.end()
  })
}

export async function createModelRequestRetryHarness(t, scenario, { idleMs = RETRY_IDLE_MS } = {}) {
  assert.ok(SCENARIOS.has(scenario))
  const tempParent = realpathSync(tmpdir())
  const root = mkdtempSync(join(tempParent, ROOT_PREFIX))
  const paths = Object.fromEntries(['workspace', 'data', 'config', 'artifacts', 'tokenHome', 'temp', 'output'].map((name) => [name, join(root, name)]))
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  Object.assign(paths, { root, database: join(paths.data, 'app.db'), target: join(paths.workspace, 'retry-output.txt'),
    partial: join(paths.workspace, 'unfinished-output.txt') })
  writeFileSync(join(paths.config, 'runtime.json'), JSON.stringify({ env: {} }), 'utf8')
  const provider = providerFor(paths, scenario, idleMs)
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
  const port = provider.server.address().port
  const env = { ...isolatedEnvironment(paths, port), WORKSPACE_SHELL_ENABLED: '0',
    MODEL_FIRST_TOKEN_TIMEOUT_MS: '2400', MODEL_IDLE_TIMEOUT_MS: String(idleMs) }
  const providerId = await seedIsolatedProvider(t, paths, env, port)
  return { paths, provider: provider.state, snapshot: () => snapshot(paths),
    run: (options) => runProcess(t, paths, env, providerId, provider.state, options),
    output: () => existsSync(paths.target) ? readFileSync(paths.target, 'utf8') : null,
    partialExists: () => existsSync(paths.partial) }
}

export function retryDiagnosis(run, harness) {
  return JSON.stringify({ status: run.status, timedOut: run.timedOut, stderr: run.stderr.slice(-4000),
    requests: harness.provider.mainRequests.length, failures: harness.provider.failures,
    events: run.events.map((event) => ({ type: event.type, phase: event.payload?.phase, name: event.payload?.name,
      code: event.payload?.code || event.payload?.result?.code, error: event.payload?.error })) })
}

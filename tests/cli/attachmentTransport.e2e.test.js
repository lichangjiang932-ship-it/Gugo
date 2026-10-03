import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import Database from 'better-sqlite3'

const cli = fileURLToPath(new URL('../../bin/yma-cli.js', import.meta.url))
const guard = new URL('./helpers/artifactCompletionNetworkGuard.mjs', import.meta.url).href
const marker = 'CLI_ATTACHMENT_BYTES_731'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gugo-attachment-wire-'))
  const paths = Object.fromEntries(['workspace', 'data', 'temp', 'profile', 'artifacts', 'config'].map((name) => [name, join(root, name)]))
  for (const directory of Object.values(paths)) mkdirSync(directory)
  writeFileSync(join(paths.workspace, 'literal.txt'), marker)
  writeFileSync(join(paths.workspace, 'pixel.png'), png)
  const bodies = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    request.once('end', () => {
      const body = JSON.parse(raw)
      if (body.messages?.some((message) => String(message.content).startsWith('Extract durable cross-session memories'))) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"memories":[]}' }, finish_reason: 'stop' }] }))
        return
      }
      bodies.push(body)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ATTACHMENT_OK' } }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const inherited = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].flatMap((name) => {
    const actual = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase())
    return actual ? [[name, process.env[actual]]] : []
  }))
  const env = { ...inherited, PATH: dirname(process.execPath), TEMP: paths.temp, TMP: paths.temp, TMPDIR: paths.temp,
    USERPROFILE: paths.profile, HOME: paths.profile, APPDATA: paths.profile, LOCALAPPDATA: paths.profile,
    APP_DATA_DIR: paths.data, APP_DB_PATH: join(paths.data, 'app.db'), ARTIFACT_DIR: paths.artifacts,
    APP_CONFIG_PATH: join(paths.config, 'runtime.json'), GUGO_LOAD_DOTENV: '0', AUTH_MODE: 'local',
    WORKSPACE_FS_ENABLED: '1', WORKSPACE_SHELL_ENABLED: '0', WORKSPACE_ROOT: paths.workspace,
    MODEL_NAME: 'gpt-cli-attachment-fixture', MODEL_PROVIDERS: 'fixture',
    MODEL_PROVIDER_FIXTURE_BASE_URL: `http://127.0.0.1:${port}/v1`, MODEL_PROVIDER_FIXTURE_MODELS: 'gpt-cli-attachment-fixture',
    MODEL_PROVIDER_FIXTURE_PROFILE: JSON.stringify({ kind: 'openai-compatible', supportsTools: true, supportsVision: true, supportsPdf: true, contextWindow: 16384 }),
    GUGO_CLI_TEST_PROVIDER_PORT: String(port), JOB_MAX_ITERS: '3', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const run = (args, extra = {}) => new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', guard, cli, ...args], { cwd: paths.workspace,
      env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`CLI fixture timed out: ${stderr}`)) }, 45_000)
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value })
    child.once('error', (error) => { clearTimeout(deadline); reject(error) })
    child.once('close', (code) => { clearTimeout(deadline); done({ code, stdout, stderr }) })
    child.stdin.end()
  })
  const snapshot = () => {
    const db = new Database(env.APP_DB_PATH, { readonly: true, fileMustExist: true })
    try { return { attachments: db.prepare('SELECT original_name,message_id,session_id FROM managed_attachments').all(),
      events: db.prepare('SELECT type,payload_json FROM turn_events ORDER BY created_at,sequence').all() } }
    finally { db.close() }
  }
  return { run, bodies, snapshot, paths }
}

test('real CLI process sends managed text/image bytes to its only loopback provider and retains bound receipts', { timeout: 100_000 }, async (t) => {
  const f = await fixture(t)
  for (const [flag, file] of [['--file', 'literal.txt'], ['--image', 'pixel.png']]) {
    const before = f.bodies.length
    const run = await f.run(['run', 'Do not call any tools. Only reply ATTACHMENT_OK.', flag, file, '--cwd', f.paths.workspace])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.ok(f.bodies.length > before)
    const sent = JSON.stringify(f.bodies[before].messages)
    assert.ok(sent.includes(file === 'literal.txt' ? marker : `data:image/png;base64,${png.toString('base64')}`), sent.slice(-3000))
    assert.equal(run.stdout.includes(marker), false, 'JSONL diagnostics never echo attachment content')
  }
  const snapshot = f.snapshot()
  assert.equal(snapshot.attachments.length, 2)
  assert.ok(snapshot.attachments.every((entry) => entry.message_id && entry.session_id))
  assert.equal(snapshot.events.filter((event) => event.type === 'turn.completed').length, 2)
})

test('real CLI refuses unsupported images before any model request and cleans unbound staging', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t)
  const run = await f.run(['run', 'Read the attachment.', '--image', 'pixel.png'], {
    MODEL_PROVIDER_FIXTURE_PROFILE: JSON.stringify({ supportsTools: true, supportsVision: false }),
  })
  assert.equal(run.code, 2, run.stdout + run.stderr)
  assert.match(run.stdout, /CLI_ATTACHMENT_MODEL_UNSUPPORTED/u)
  assert.equal(f.bodies.length, 0)
  assert.deepEqual(f.snapshot().attachments, [])
})

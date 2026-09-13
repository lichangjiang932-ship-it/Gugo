import '../../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CLI_PATH, NETWORK_GUARD, MODEL_NAME, isolatedEnvironment, seedProvider, modelReply } from './helpers/artifactCompletionHarness.js'

test('real CLI closes promptly after final output without waiting for optional memory', { timeout: 30_000 }, async (t) => {
  const parent = realpathSync(tmpdir())
  const root = mkdtempSync(join(parent, 'gugo-cli-memory-close-'))
  const paths = Object.fromEntries(['workspace', 'data', 'config', 'artifacts', 'tokenHome', 'temp', 'output']
    .map((name) => [name, join(root, name)]))
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  paths.database = join(paths.data, 'app.db')
  writeFileSync(join(paths.config, 'runtime.json'), JSON.stringify({ env: {} }))
  const pendingTimers = new Set()
  const memoryRequests = []
  const finalText = 'CLI_COMPLETE_WITHOUT_WAITING_FOR_OPTIONAL_MEMORY'
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      const memory = body.messages?.some((message) => String(message.content).includes('Extract durable cross-session memories'))
      if (!memory) { modelReply(res, { content: finalText }); return }
      const observation = { receivedAt: Date.now(), closedAt: null, replied: false }
      memoryRequests.push(observation)
      // A successful but slow optional response used to hold CLI exit open.
      const timer = setTimeout(() => {
        observation.replied = true
        pendingTimers.delete(timer)
        modelReply(res, { content: JSON.stringify({ memories: [{ type: 'project', title: 'late memory',
          body: 'The fixture project uses SQLite.', confidence: 0.99 }] }) })
      }, 8_000)
      pendingTimers.add(timer)
      res.once('close', () => {
        observation.closedAt = Date.now()
        clearTimeout(timer)
        pendingTimers.delete(timer)
      })
    })
  })
  t.after(async () => {
    for (const timer of pendingTimers) clearTimeout(timer)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(dirname(realpathSync(root)), parent)
    assert.ok(basename(root).startsWith('gugo-cli-memory-close-'))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const env = isolatedEnvironment(paths, port)
  const providerId = seedProvider(env, paths, port)
  const prompt = 'This project always uses SQLite. Reply with the completion marker only.'
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', NETWORK_GUARD, CLI_PATH, 'run', prompt,
      '--mode', 'plan', '--cwd', paths.workspace, '--provider', providerId, '--model', MODEL_NAME], {
      cwd: paths.workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let terminalAt = null
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${stderr}`)) }, 20_000)
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
      if (terminalAt === null && stdout.includes('"type":"turn.completed"')) terminalAt = Date.now()
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr, terminalAt, closedAt: Date.now() })
    })
    child.stdin.end()
  })
  const diagnostic = JSON.stringify({ ...result, memoryRequests })
  assert.equal(result.status, 0, diagnostic)
  const events = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  const completed = events.find((event) => event.type === 'turn.completed')
  assert.equal(completed?.payload?.text, finalText, diagnostic)
  assert.ok(result.terminalAt !== null, diagnostic)
  assert.ok(result.closedAt - result.terminalAt < 2_000, diagnostic)
  assert.ok(memoryRequests.length <= 1, diagnostic)
  assert.ok(memoryRequests.every((request) => request.replied === false), diagnostic)
  assert.doesNotMatch(result.stderr, /memory\.auto_extract/u)
  const db = new DatabaseSync(paths.database, { readOnly: true })
  try {
    const messages = db.prepare('SELECT role, content FROM messages WHERE session_id = ?').all(completed.sessionId)
    assert.ok(messages.some((message) => message.role === 'user' && message.content === prompt))
    assert.ok(messages.some((message) => message.role === 'assistant' && message.content === finalText))
    assert.equal(db.prepare('SELECT count(*) AS count FROM memories').get().count, 0)
  } finally { db.close() }
  t.diagnostic(`final-to-close ${result.closedAt - result.terminalAt}ms; optional requests ${memoryRequests.length}`)
})

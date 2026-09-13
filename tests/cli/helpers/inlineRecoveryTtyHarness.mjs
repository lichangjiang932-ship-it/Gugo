import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { isolatedEnvironment, seedProvider, modelReply, CLI_PATH, NETWORK_GUARD, MODEL_NAME } from './artifactCompletionHarness.js'

const scenario = process.argv[2]
assert.ok(['directory', 'directory-resume', 'ordinary', 'committed', 'failed', 'defer', 'ordinary-yes'].includes(scenario))
assert.equal(process.stdin.isTTY, true, 'Launch this harness in a real terminal; do not fake isTTY.')
assert.equal(process.stderr.isTTY, true)
const tempParent = realpathSync(tmpdir())
const root = mkdtempSync(join(tempParent, 'gugo-cli-inline-e2e-'))
const paths = Object.fromEntries(['workspace', 'data', 'config', 'artifacts', 'tokenHome', 'temp', 'output', 'external']
  .map(name => [name, join(root, name)]))
for (const directory of Object.values(paths)) mkdirSync(directory)
paths.database = join(paths.data, 'app.db')
paths.target = join(paths.workspace, 'unknown-target.txt')
writeFileSync(join(paths.config, 'runtime.json'), '{"env":{}}')
writeFileSync(join(paths.external, 'fixture.txt'), 'INLINE_DIRECTORY_CONTENT')
const isDirectory = scenario.startsWith('directory')
const isUnknown = !isDirectory && scenario !== 'ordinary'
let stage = 0
let modelRequests = 0
let completed = false
let selected = false
const failures = []
function toolResult(body, id) {
  const message = body.messages.findLast(entry => entry.role === 'tool' && entry.tool_call_id === id)
  assert.ok(message, `missing actual tool result: ${id}`)
  return JSON.parse(message.content)
}
function reply(body) {
  if (completed && !body.tools?.length) return { content: '{"memories":[]}' }
  modelRequests += 1
  assert.ok(modelRequests <= 8)
  if (stage++ === 0) {
    const toolCall = isDirectory
      ? { id: 'inline-directory', name: 'request_directory', args: {
        purpose: 'Read the isolated external fixture.', access_mode: 'read_only', suggested_path: paths.external,
      } }
      : scenario === 'ordinary'
        ? { id: 'inline-ordinary', name: 'write_file', args: { path: paths.target, content: 'CLI_APPROVAL_OK' } }
        : { id: 'inline-unknown-write', name: 'write_file', args: { path: paths.target, content: 'SIDE_EFFECT_ONCE' } }
    assert.ok(body.tools?.some(tool => tool.function?.name === toolCall.name), `missing tool: ${toolCall.name}`)
    return { toolCall }
  }
  if (isDirectory && stage === 2) {
    return { toolCall: { id: 'inline-directory-read', name: 'read_file', args: { path: join(paths.external, 'fixture.txt') } } }
  }
  if (isDirectory) {
    assert.equal(toolResult(body, 'inline-directory-read').content, 'INLINE_DIRECTORY_CONTENT')
  } else if (isUnknown) {
    const result = toolResult(body, 'inline-unknown-write')
    assert.equal(result.userConfirmed, true, 'unknown must reach the provider only after real verification')
    assert.equal(result.ok, scenario === 'committed')
    if (scenario === 'failed' && stage === 2) {
      return { toolCall: { id: 'inline-new-write-after-verification', name: 'write_file',
        args: { path: paths.target, content: 'SIDE_EFFECT_ONCE' } } }
    }
    const produced = scenario === 'failed' ? toolResult(body, 'inline-new-write-after-verification') : result
    assert.equal(produced.ok, true)
    if (!selected && produced.artifactId) {
      selected = true
      return { toolCall: { id: 'inline-select-result', name: 'set_deliverables', args: { artifact_ids: [produced.artifactId] } } }
    }
    if (selected) assert.equal(toolResult(body, 'inline-select-result').ok, true)
  } else {
    const produced = toolResult(body, 'inline-ordinary')
    assert.equal(produced.ok, true)
    if (!selected && produced.artifactId) {
      selected = true
      return { toolCall: { id: 'inline-select-result', name: 'set_deliverables', args: { artifact_ids: [produced.artifactId] } } }
    }
    if (selected) assert.equal(toolResult(body, 'inline-select-result').ok, true)
  }
  completed = true
  return { content: isDirectory ? 'INLINE_DIRECTORY_CONTENT' : scenario === 'ordinary' ? 'CLI_APPROVAL_OK' : 'The isolated operation was verified.' }
}
const server = createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    try {
      assert.equal(req.url, '/v1/chat/completions')
      modelReply(res, reply(JSON.parse(raw)))
    } catch (error) {
      failures.push(error.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
})

function snapshot() {
  const db = new Database(paths.database, { readonly: true, fileMustExist: true })
  try {
    return {
      settings: ['user_approval_settings', 'local_file_access_settings', 'local_file_grants']
        .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY user_id`).all()),
      events: db.prepare('SELECT type, sequence, turn_id, session_id, payload_json FROM turn_events ORDER BY sequence').all()
        .map(row => ({ type: row.type, sequence: row.sequence, turnId: row.turn_id, sessionId: row.session_id, payload: JSON.parse(row.payload_json) })),
      ledger: db.prepare('SELECT tool_call_id, status FROM side_effect_executions WHERE effect_kind = ? ORDER BY prepared_at').all('tool'),
    }
  } finally { db.close() }
}

function runCli(env, providerId, { noninteractive = false, resume = null } = {}) {
  const args = ['--import', NETWORK_GUARD]
  if (isUnknown) args.push('--import', new URL('./inlineRecoveryWriteFault.mjs', import.meta.url).href)
  args.push(CLI_PATH, 'run')
  if (resume) args.push('--resume', resume.turnId, '--session-id', resume.sessionId)
  else args.push(isDirectory ? 'Read the isolated fixture file and report its literal text.'
    : scenario === 'ordinary' ? 'Create a small text file containing CLI_APPROVAL_OK and return the file.'
      : 'Perform the isolated local operation and verify its result.',
    '--mode', scenario === 'ordinary' || isDirectory ? 'normal' : 'bypass', '--provider', providerId, '--model', MODEL_NAME)
  args.push('--cwd', paths.workspace, '--output', 'jsonl', '--timeout', '45000')
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: paths.workspace, env, windowsHide: true,
      stdio: [noninteractive ? 'pipe' : 'inherit', 'pipe', noninteractive ? 'pipe' : 'inherit'] })
    let output = ''
    let diagnostics = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr?.setEncoding('utf8').on('data', chunk => { diagnostics += chunk })
    if (noninteractive) child.stdin.end()
    child.once('error', reject)
    child.once('close', (status, signal) => resolveRun({ status, signal, diagnostics,
      events: output.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) }))
  })
}

try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const env = { ...isolatedEnvironment(paths, port), GUGO_CLI_INLINE_TEST_ROOT: root,
    GUGO_CLI_INLINE_FAULT: scenario === 'failed' ? 'before' : 'after' }
  const providerId = seedProvider(env, paths, port)
  const initial = snapshot()
  process.stderr.write(`\n[real-TTY fixture] ${scenario}; isolated root: ${root}\n`)
  let resume = null
  if (scenario === 'directory-resume') {
    const first = await runCli(env, providerId, { noninteractive: true })
    assert.equal(first.status, 1)
    assert.equal(first.events.at(-1).type, 'turn.paused')
    resume = first.events.find(event => event.type === 'turn.started')
    assert.equal(modelRequests, 1)
  }
  const run = await runCli(env, providerId, { resume })
  const final = snapshot()
  const diagnostics = JSON.stringify({ failures, status: run.status, events: run.events.filter(event => (
    event.type === 'cli.error' || event.type === 'tool.completed' || event.type.startsWith('turn.') && event.type !== 'turn.checkpoint'
  )).map(event => ({ type: event.type, code: event.error?.code || event.payload?.code,
    toolCallId: event.payload?.toolCallId, resultCode: event.payload?.result?.code, ok: event.payload?.result?.ok,
    incompleteReason: event.payload?.incompleteReason })) })
  assert.deepEqual(failures, [], diagnostics)
  assert.equal(run.status, ['defer', 'ordinary-yes'].includes(scenario) ? 1 : 0, diagnostics)
  assert.deepEqual(final.settings, initial.settings, 'no account settings or persistent grants may change')
  assert.equal(new Set(final.events.map(event => event.turnId)).size, 1)
  assert.equal(final.events.filter(event => event.type === 'turn.started').length, 1)
  if (isDirectory) {
    const resumed = final.events.find(event => event.type === 'turn.resumed')
    assert.ok(resumed, JSON.stringify(run))
    assert.equal(resumed.payload.resolution.path, realpathSync(paths.external))
    assert.equal(resumed.payload.resolution.access_mode, 'read_only')
    assert.equal(resumed.payload.resolution.authorization_scope, 'session')
  } else if (isUnknown) {
    const attempts = readFileSync(join(root, 'write-attempts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(attempts.length, scenario === 'failed' ? 2 : 1, 'the unknown tool call must never be replayed')
    assert.equal(final.ledger.find(row => row.tool_call_id === 'inline-unknown-write').status,
      ['defer', 'ordinary-yes'].includes(scenario) ? 'unknown' : scenario)
    assert.equal(readFileSync(paths.target, 'utf8'), 'SIDE_EFFECT_ONCE')
    assert.ok(final.events.some(event => event.type === 'turn.blocked' && event.payload.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN'))
  } else {
    assert.ok(final.events.some(event => event.type === 'approval.required'))
    assert.ok(final.events.some(event => event.type === 'approval.resolved'))
  }
  process.stdout.write(`\nREAL_TTY_PASS ${JSON.stringify({ scenario, status: run.status, modelRequests,
    terminal: final.events.at(-1).type, ledger: final.ledger, accountSettingsUnchanged: true })}\n`)
} finally {
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  assert.equal(dirname(realpathSync(root)), tempParent)
  assert.ok(basename(root).startsWith('gugo-cli-inline-e2e-'))
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

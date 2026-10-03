import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { CLI_PATH, NETWORK_GUARD, isolatedEnvironment, seedProvider, modelReply } from './artifactCompletionHarness.js'

export const moduleUrl = (file) => new URL(`../../../${file}`, import.meta.url).href
export const PROMPT = 'Do not call tools. Only reply WORKSPACE_READY.'

function runProcess(paths, env, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', NETWORK_GUARD, ...args], {
      cwd: paths.launcher, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`workspace session fixture timed out: ${stderr}`))
    }, 45_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }) })
    child.stdin.end()
  })
}

export async function workspaceSessionFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gugo-workspace-session-'))
  const paths = Object.fromEntries(['workspace', 'other', 'launcher', 'data', 'config', 'temp', 'tokenHome', 'artifacts', 'output']
    .map((key) => [key, join(root, key)]))
  for (const directory of Object.values(paths)) mkdirSync(directory)
  for (const key of Object.keys(paths)) paths[key] = realpathSync(paths[key])
  paths.database = join(paths.data, 'app.db')
  writeFileSync(join(paths.workspace, 'AGENTS.md'), 'SELECTED_WORKSPACE_INSTRUCTIONS: respond normally.\n')
  writeFileSync(join(paths.other, 'AGENTS.md'), 'OTHER_WORKSPACE_INSTRUCTIONS: respond normally.\n')
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    request.once('end', () => {
      const body = JSON.parse(raw || '{}')
      const extraction = body.messages?.some((message) => String(message.content)
        .startsWith('Extract durable cross-session memories'))
      if (!extraction) requests.push(body)
      modelReply(response, { content: extraction ? '{"memories":[]}' : 'WORKSPACE_READY' })
    })
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}\\`) || resolve(root).startsWith(`${resolve(tmpdir())}/`))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const env = isolatedEnvironment(paths, server.address().port)
  seedProvider(env, paths, server.address().port)
  function evaluate(script, overrides = {}) {
    const result = spawnSync(process.execPath, ['--import', NETWORK_GUARD, '--input-type=module', '--eval', script], {
      cwd: paths.launcher, env: { ...env, ...overrides }, windowsHide: true, encoding: 'utf8', timeout: 20_000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(result.stdout)
  }
  const seeded = evaluate(`
    const { bootstrapAuth } = await import(${JSON.stringify(moduleUrl('server/adapters/authAccount.js'))})
    const { closeDb, createUser } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    const { setDefaultOutputDirectory } = await import(${JSON.stringify(moduleUrl('server/services/localFileAccessService.js'))})
    try {
      const { user } = bootstrapAuth({ env: process.env })
      createUser({ id: 'workspace-other-owner', email: 'workspace-other-owner@example.invalid' })
      setDefaultOutputDirectory({ userId: user.id, rootPath: ${JSON.stringify(paths.output)} })
      process.stdout.write(JSON.stringify({ userId: user.id }))
    } finally { closeDb() }
  `)
  function read(sessionId) {
    const db = new Database(paths.database, { readonly: true, fileMustExist: true })
    try {
      return {
        session: db.prepare('SELECT user_id, workspace_path FROM sessions WHERE token = ?').get(sessionId) || null,
        started: db.prepare("SELECT payload_json FROM turn_events WHERE session_id = ? AND type = 'turn.started' ORDER BY rowid")
          .all(sessionId).map((row) => JSON.parse(row.payload_json)),
        grants: db.prepare('SELECT * FROM local_file_grants ORDER BY id').all(),
        trust: db.prepare('SELECT * FROM workspace_trust ORDER BY user_id, root_path').all(),
      }
    } finally { db.close() }
  }
  function run(entry, sessionId, args = [], lines = [PROMPT, '/exit'], options = {}) {
    const parsedArgs = [...args, '--session-id', sessionId]
    if (entry === 'run') return runProcess(paths, env, [CLI_PATH, 'run', PROMPT, ...parsedArgs])
    const script = `
      const { cmdChat, parseRunArgs } = await import(${JSON.stringify(moduleUrl('bin/yma-cli.js'))})
      const { closeDb } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
      try {
        const controller = new AbortController()
        if (${options.cancelled === true}) controller.abort(Object.assign(
          new Error('fixture cancelled before start'), { code: 'CLI_RUN_CANCELLED', exitCode: 130 }))
        try {
          process.exitCode = await cmdChat(parseRunArgs(${JSON.stringify(parsedArgs)}), {
            runtimeCwd: ${JSON.stringify(paths.launcher)}, env: process.env,
            lines: ${JSON.stringify(lines)}, signal: controller.signal,
          })
        } catch (error) {
          if (!controller.signal.aborted || error !== controller.signal.reason) throw error
          process.stderr.write(error.code)
          process.exitCode = error.exitCode
        }
      } finally { closeDb() }
    `
    return runProcess(paths, env, ['--input-type=module', '--eval', script])
  }
  return { paths, env, requests, userId: seeded.userId, read, run, evaluate }
}

export function webProjection(fixture, sessionId) {
  return fixture.evaluate(`
    const { getSessionSnapshot, listSessions } = await import(${JSON.stringify(moduleUrl('server/services/sessionStore.js'))})
    const { resolveTurnProjectDirectory } = await import(${JSON.stringify(moduleUrl('server/services/localFileAccessService.js'))})
    const { closeDb } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    try {
      const scope = { userId: ${JSON.stringify(fixture.userId)}, sessionId: ${JSON.stringify(sessionId)} }
      const snapshot = getSessionSnapshot(scope)
      let accessCode = null
      try { resolveTurnProjectDirectory({ userId: scope.userId, workspacePath: ${JSON.stringify(fixture.paths.workspace)} }) }
      catch (error) { accessCode = error.code }
      process.stdout.write(JSON.stringify({ snapshot: snapshot?.session || null,
        catalog: listSessions(scope).find((session) => session.id === scope.sessionId) || null,
        foreign: getSessionSnapshot({ ...scope, userId: 'workspace-other-owner' }), accessCode }))
    } finally { closeDb() }
  `, { WORKSPACE_SHARED_TRUSTED: '0', GUGO_CLI_WORKSPACE_ROOT: '', WORKSPACE_ROOT: fixture.paths.launcher })
}

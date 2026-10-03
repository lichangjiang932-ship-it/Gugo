import assert from 'node:assert/strict'
import test from 'node:test'
import { PROMPT, webProjection, workspaceSessionFixture } from './helpers/workspaceSessionHarness.js'

for (const entry of ['run', 'chat']) {
  test(`${entry} persists an explicit new-session workspace without changing output or existing session ownership`, { timeout: 100_000 }, async (t) => {
    const f = await workspaceSessionFixture(t)
    const sessionId = `${entry}-project-session`
    const before = f.read(sessionId)
    const result = await f.run(entry, sessionId, ['--cwd', f.paths.workspace])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const stored = f.read(sessionId)
    assert.equal(stored.started[0]?.projectDirectory, f.paths.workspace)
    assert.equal(stored.session?.workspace_path, f.paths.workspace)
    assert.equal(stored.started[0]?.workspacePath, f.paths.workspace)
    const prompt = f.requests[0].messages.map((message) => message.content).join('\n')
    assert.ok(prompt.includes('SELECTED_WORKSPACE_INSTRUCTIONS'))
    assert.ok(prompt.includes(`Default generated-file directory: ${f.paths.output}.`))
    assert.deepEqual(stored.grants, before.grants, 'CLI selection must not create persistent grants')
    assert.deepEqual(stored.trust, before.trust, 'CLI selection must not create persistent workspace trust')

    const projected = webProjection(f, sessionId)
    assert.equal(projected.snapshot?.workspacePath, f.paths.workspace)
    assert.equal(projected.catalog?.workspacePath, f.paths.workspace)
    assert.equal(projected.foreign, null)
    assert.equal(projected.accessCode, 'TURN_WORKSPACE_NOT_AUTHORIZED')

    const changed = await f.run(entry, sessionId, ['--cwd', f.paths.other])
    assert.equal(changed.code, 0, changed.stdout + changed.stderr)
    const continued = f.read(sessionId)
    assert.equal(continued.started.at(-1)?.projectDirectory, f.paths.other)
    assert.equal(continued.session.workspace_path, f.paths.workspace, 'continuation must not move the original session')
    assert.deepEqual(continued.grants, before.grants)
    assert.deepEqual(continued.trust, before.trust)
    const implicit = await f.run(entry, sessionId)
    assert.equal(implicit.code, 0, implicit.stdout + implicit.stderr)
    assert.equal(f.read(sessionId).session.workspace_path, f.paths.workspace, 'an implicit cwd must not clear the original project')
  })

  test(`${entry} without an explicit cwd keeps new and continued sessions in Recent`, { timeout: 100_000 }, async (t) => {
    const f = await workspaceSessionFixture(t)
    const sessionId = `${entry}-recent-session`
    const result = await f.run(entry, sessionId, [], entry === 'chat' ? ['/cwd', PROMPT, '/exit'] : undefined)
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const stored = f.read(sessionId)
    assert.equal(stored.session?.workspace_path, null)
    assert.equal(stored.started[0]?.projectDirectory, entry === 'chat' ? f.paths.launcher : f.paths.output)
    assert.equal(webProjection(f, sessionId).catalog?.workspacePath, null)
    const changed = await f.run(entry, sessionId, ['--cwd', f.paths.workspace])
    assert.equal(changed.code, 0, changed.stdout + changed.stderr)
    assert.equal(f.read(sessionId).session?.workspace_path, null, 'legacy/Recent sessions are not silently migrated')
  })
}

test('chat /cwd explicitly selects a new session project and /new preserves the current selection', { timeout: 100_000 }, async (t) => {
  const f = await workspaceSessionFixture(t)
  const result = await f.run('chat', 'slash-project-session', [], [
    `/cwd ${f.paths.workspace}`, PROMPT,
    `/cwd ${f.paths.other}`, PROMPT,
    '/new', '/session slash-new-session', PROMPT, '/exit',
  ])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const original = f.read('slash-project-session')
  assert.equal(original.session?.workspace_path, f.paths.workspace)
  assert.deepEqual(original.started.map((started) => started.projectDirectory), [f.paths.workspace, f.paths.other])
  assert.equal(f.read('slash-new-session').session?.workspace_path, f.paths.other)
})

test('invalid cwd and pre-start cancellation create no session metadata or model requests', { timeout: 100_000 }, async (t) => {
  const f = await workspaceSessionFixture(t)
  const invalid = await f.run('run', 'invalid-cwd-session', ['--cwd', `${f.paths.workspace}/missing`])
  assert.equal(invalid.code, 2, invalid.stdout + invalid.stderr)
  assert.match(invalid.stdout, /CLI_CWD_NOT_FOUND/u)
  assert.equal(f.read('invalid-cwd-session').session, null)
  const cancelled = await f.run('chat', 'cancelled-session', ['--cwd', f.paths.workspace], [PROMPT, '/exit'], { cancelled: true })
  assert.equal(cancelled.code, 130, cancelled.stdout + cancelled.stderr)
  assert.equal(f.read('cancelled-session').session, null)
  assert.equal(f.requests.length, 0)
})

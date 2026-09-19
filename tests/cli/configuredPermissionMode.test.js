import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test, { after } from 'node:test'
import { cmdRun, parseRunArgs } from '../../bin/yma-cli.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'
import { runHeadlessTurn } from '../../server/services/headlessTurnRuntime.js'
import { closeDb, createUser } from '../../server/db.js'
import { getApprovalMode, setApprovalMode } from '../../server/services/approvalSettingsStore.js'

const root = mkdtempSync(path.join(tmpdir(), 'gugo-cli-account-mode-'))
process.env.APP_DATA_DIR = root
process.env.APP_DB_PATH = path.join(root, 'app.db')
createUser({ id: 'cli-mode-owner', email: 'cli-mode-owner@example.invalid' })
after(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })

function stream() {
  const chunks = []
  return { chunks, output: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } }) }
}

async function run(args, dependencies = {}) {
  const stdout = stream()
  const stderr = stream()
  const starts = []
  const events = []
  let listener = () => {}
  const emit = (request) => {
    const event = { id: 'completed', sessionId: request.sessionId, turnId: request.turnId, sequence: 0,
      type: 'turn.completed', payload: { text: 'fixture complete' }, createdAt: 1 }
    events.push(event)
    listener(event)
  }
  const code = await cmdRun(args, {
    stdin: Readable.from([]), stdout: stdout.output, stderr: stderr.output,
    runTurn: (options) => runHeadlessTurn(options, {
      configureWorkspace: (value) => value,
      bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: 'cli-mode-owner' } }),
      idFactory: () => 'fixture-id', persistenceAdapter: {},
      subscribeEvents: (_scope, callback) => { listener = callback; return () => {} },
      listEvents: ({ after }) => events.filter((event) => event.sequence > after),
      engine: {
        startTurn: async (request) => { starts.push(request); emit(request) },
        recoverTurn: async (request) => emit(request), waitForTurn: async () => {},
      },
      ...dependencies,
    }),
  })
  return { code, starts, stdout: stdout.chunks.join(''), stderr: stderr.chunks.join('') }
}

test('an implicit CLI mode respects the saved read-only plan but never inherits broader saved modes', async () => {
  for (const saved of ['plan', 'normal', 'acceptEdits', 'bypass']) {
    setApprovalMode({ userId: 'cli-mode-owner', mode: saved })
    const result = await run(['hello'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.starts[0].approvalMode, saved === 'plan' ? 'plan' : 'normal', saved)
    assert.equal(result.starts[0].intentMode, saved === 'plan' ? 'answer' : 'auto')
    assert.equal(getApprovalMode({ userId: 'cli-mode-owner' }), saved, 'a turn must not rewrite the saved account mode')
  }
})

test('explicit CLI modes remain per-turn choices and lookup failures do not fall back to normal', async () => {
  setApprovalMode({ userId: 'cli-mode-owner', mode: 'plan' })
  for (const selected of ['normal', 'plan', 'acceptEdits', 'bypass']) {
    const result = await run(['hello', '--mode', selected], {
      readApprovalMode: () => { throw new Error('explicit mode must not be reselected') },
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.starts[0].approvalMode, selected)
    assert.equal(getApprovalMode({ userId: 'cli-mode-owner' }), 'plan')
  }
  const failed = await run(['hello'], {
    readApprovalMode: () => { throw Object.assign(new Error('account policy unavailable'), { code: 'FIXTURE_POLICY_UNAVAILABLE' }) },
  })
  assert.equal(failed.code, 1)
  assert.deepEqual(failed.starts, [])
  assert.match(failed.stdout, /FIXTURE_POLICY_UNAVAILABLE/u)
})

test('chat keeps default and explicitly selected modes distinct across turns', async () => {
  const stdout = stream()
  const seen = []
  const code = await startInteractiveSession({ options: parseRunArgs([]), env: {},
    lines: ['hello', '/mode normal', 'hello again', '/exit'], stdout: stdout.output, stderr: stdout.output,
    resolveUserId: async () => 'cli-mode-owner', readModelProviders: async () => [],
    runTurn: async (options) => { seen.push(options); return { status: 'completed', exitCode: 0 } },
  })
  assert.equal(code, 0)
  assert.deepEqual(seen.map(({ mode, modeExplicit }) => ({ mode, modeExplicit })), [
    { mode: 'normal', modeExplicit: false }, { mode: 'normal', modeExplicit: true },
  ])
})

test('resume does not reselect account permissions or add a new mode override', async () => {
  const result = await run(['--resume', 'old-turn', '--session-id', 'old-session'], {
    readApprovalMode: () => { throw new Error('resume must retain its checkpoint policy') },
  })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.starts, [])
})

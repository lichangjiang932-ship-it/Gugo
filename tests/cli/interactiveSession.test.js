import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test, { after } from 'node:test'

import {
  appendInteractiveHistory,
  completeInteractiveLine,
  INTERACTIVE_COMMANDS,
  INTERACTIVE_MODES,
  isRecordableHistoryLine,
  parseInteractiveHistory,
  parseInteractiveLine,
  readInteractiveHistory,
  renderInteractiveHelp,
  resolveInteractiveHistoryPath,
  sessionStatusLine,
  startInteractiveSession,
  writeInteractiveHistory,
} from '../../bin/cli/interactiveSession.js'
import { CliError, CliUsageError } from '../../bin/cli/errors.js'
import { closeDb } from '../../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../../server/adapters/authAccount.js'
import { upsertSession } from '../../server/services/sessionStore.js'
import { approveGoalPlan, createGoalPlan } from '../../server/services/goalPlanService.js'

test('/plan and implicit /approve find the current session before applying the history limit', async () => {
  const issued = issueEmailCode({ email: 'cli-goal-scope@example.invalid' })
  const owner = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
  const sessionId = 'cli-older-goal-session'
  upsertSession({ id: sessionId, userId: owner, title: 'Older active session' })
  upsertSession({ id: 'cli-busy-goal-session', userId: owner, title: 'Other session' })
  const plan = createGoalPlan({ userId: owner, sessionId, now: 1,
    objective: 'Visible older session plan', steps: [{ title: 'Inspect fixture' }] })
  for (let index = 0; index < 55; index += 1) {
    createGoalPlan({ userId: owner, sessionId: 'cli-busy-goal-session', now: 100 + index,
      objective: `Other plan ${index}`, steps: [{ title: 'Other fixture' }] })
  }
  const out = capture()
  const code = await startInteractiveSession({ options: { sessionId, mode: 'normal', cwd: '/w' },
    lines: ['/plan', '/approve', '/exit'], stdout: out.stream, stderr: out.stream,
    runTurn: async () => { assert.fail('commands must not start a model turn') }, resolveUserId: async () => owner,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /Visible older session plan/)
  assert.ok(out.text().includes(`Approved ${plan.id}`))
})

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-interactive-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function capture() {
  const chunks = []
  return {
    chunks,
    stream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } }),
    text() { return chunks.join('') },
  }
}

function turnRecorder(result = { status: 'completed', exitCode: 0, sessionId: 'sess-1' }) {
  const calls = []
  const runtime = async (input) => {
    calls.push(input)
    input.onEvent?.({ type: 'turn.started', payload: {} })
    if (input.prompt === 'explode') throw new Error('model unavailable')
    input.onEvent?.({ type: 'turn.completed', payload: { text: `echo:${input.prompt}` } })
    return { ...result, sessionId: input.sessionId || result.sessionId }
  }
  return { calls, runtime }
}

test('interactive line parsing separates prompts from commands', () => {
  assert.deepEqual(parseInteractiveLine('   '), { kind: 'empty' })
  assert.deepEqual(parseInteractiveLine('fix the bug'), { kind: 'prompt', prompt: 'fix the bug' })
  assert.deepEqual(parseInteractiveLine('/help'), { kind: 'command', name: '/help', args: '' })
  assert.deepEqual(parseInteractiveLine('/MODE  bypass '), { kind: 'command', name: '/mode', args: 'bypass' })
  // A path-like first word must not be mistaken for a command.
  assert.deepEqual(parseInteractiveLine('/usr/bin/env is broken'), {
    kind: 'command', name: '/usr/bin/env', args: 'is broken',
  })
  assert.match(renderInteractiveHelp(), /\/exit/)
  assert.match(sessionStatusLine({ sessionId: 'abcdef123456', mode: 'plan', model: null, cwd: '/w' }), /plan/)
  for (const entry of INTERACTIVE_COMMANDS) assert.ok(entry.description)
  assert.deepEqual([...INTERACTIVE_MODES], ['normal', 'acceptEdits', 'plan', 'bypass'])
})

test('interactive sessions refuse to start without a TTY', async () => {
  const stdout = capture()
  const stdin = { isTTY: false }
  await assert.rejects(
    startInteractiveSession({
      stdin, stdout: stdout.stream, stderr: stdout.stream,
      runTurn: async () => {},
      resolveUserId: async () => 'user-1',
    }),
    (error) => error instanceof CliError && error.code === 'CLI_INTERACTIVE_REQUIRES_TTY',
  )
})

test('interactive sessions keep one session across turns and honour settings changes', async () => {
  const out = capture()
  const err = capture()
  const { calls, runtime } = turnRecorder()
  const code = await startInteractiveSession({
    options: { sessionId: 'sess-1', model: 'start-model', mode: 'normal', cwd: '/workspace' },
    lines: ['first prompt', '/mode acceptEdits', '/model other-model', 'second prompt', '/exit'],
    stdout: out.stream, stderr: err.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 2, 'two prompts produced two turns')
  assert.equal(calls[0].sessionId, 'sess-1')
  assert.equal(calls[1].sessionId, 'sess-1', 'the session is reused, not recreated')
  assert.equal(calls[0].mode, 'normal')
  assert.equal(calls[1].mode, 'acceptEdits', 'settings changes apply to later turns')
  assert.equal(calls[0].model, 'start-model')
  assert.equal(calls[1].model, 'other-model')
  assert.equal(calls[0].workspaceExplicit, true)
  assert.equal(calls[0].token, '', 'headless turns never consume a server token')
  assert.match(out.text(), /echo:first prompt/)
  assert.match(out.text(), /echo:second prompt/)
  // Unknown commands are reported without ending the session.
  assert.match(err.text(), /mode acceptEdits|turn completed/)
})

test('local session discovery and resume select only an owned session without restoring turn permissions', async () => {
  const issued = issueEmailCode({ email: 'cli-resume-owner@example.invalid' })
  const owner = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
  const otherIssued = issueEmailCode({ email: 'cli-resume-other@example.invalid' })
  const other = verifyEmailCode({ email: otherIssued.email, code: otherIssued.devCode }).user.id
  upsertSession({ id: 'owned-session-full-id', userId: owner, title: 'Earlier conversation' })
  upsertSession({ id: 'foreign-session-full-id', userId: other, title: 'Private conversation' })
  const out = capture()
  const err = capture()
  const { calls, runtime } = turnRecorder()
  const code = await startInteractiveSession({
    options: { sessionId: 'current-session', mode: 'normal', model: 'current-model', cwd: '/current' },
    lines: ['/sessions', '/resume', '/resume missing-session', '/resume foreign-session-full-id',
      'before valid resume', '/resume owned-session-full-id', 'continue conversation', '/exit'],
    stdout: out.stream, stderr: err.stream, runTurn: runtime, resolveUserId: async () => owner,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /owned-session-full-id.*Earlier conversation/u)
  assert.doesNotMatch(out.text(), /Private conversation|foreign-session-full-id/u)
  assert.match(err.text(), /\/resume requires a session id/u)
  assert.equal((err.text().match(/Session not found/gu) || []).length, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].sessionId, 'current-session')
  assert.equal(calls[1].sessionId, 'owned-session-full-id')
  assert.equal(calls[1].prompt, 'continue conversation')
  assert.equal(calls[1].resumeTurnId, undefined)
  assert.equal(calls[1].mode, 'normal')
  assert.equal(calls[1].model, 'current-model')
  assert.equal(calls[1].cwd, '/current')
  assert.equal(calls[1].token, '')
})

test('local session discovery paginates archived history and rejects invalid offsets without turns', async () => {
  const { archiveSession } = await import('../../server/services/sessionStore.js')
  const issued = issueEmailCode({ email: 'cli-session-pages@example.invalid' })
  const owner = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
  for (let index = 0; index < 21; index += 1) {
    upsertSession({ id: `page-session-${String(index).padStart(2, '0')}`, userId: owner,
      title: `History ${index}`, now: 100 + index })
  }
  archiveSession({ userId: owner, sessionId: 'page-session-20', now: 1000 })
  const out = capture()
  const err = capture()
  await startInteractiveSession({
    lines: ['/sessions', '/sessions 20', '/sessions 40', '/sessions -1', '/sessions 1.5',
      '/sessions 9007199254740992', '/resume page-session', '/resume page-session-20', '/exit'],
    stdout: out.stream, stderr: err.stream, resolveUserId: async () => owner,
    runTurn: async () => { assert.fail('session discovery must not start a turn') },
  })
  assert.match(out.text(), /Next page: \/sessions 20/u)
  assert.match(out.text(), /page-session-20 {2}History 20 \[archived\]/u)
  for (let index = 0; index < 21; index += 1) {
    assert.ok(out.text().includes(`page-session-${String(index).padStart(2, '0')}  History ${index}`))
  }
  assert.match(out.text(), /No local sessions on this page/u)
  assert.equal((err.text().match(/offset must be a non-negative integer/gu) || []).length, 3)
  assert.match(err.text(), /Session not found/u)
  assert.match(out.text(), /Continuing session page-session-20/u)
})

test('EOF and /exit both end the session cleanly', async () => {
  const out = capture()
  const { calls, runtime } = turnRecorder()
  const eof = await startInteractiveSession({
    options: { sessionId: 'sess-eof', mode: 'normal', cwd: '/w' },
    lines: ['only prompt'],
    stdout: out.stream, stderr: out.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  assert.equal(eof, 0)
  assert.equal(calls.length, 1)
})

test('a failing command is reported and the session continues', async () => {
  const out = capture()
  const err = capture()
  const { calls, runtime } = turnRecorder()
  const code = await startInteractiveSession({
    options: { sessionId: 'sess-err', mode: 'normal', cwd: '/w' },
    lines: ['/mode sideways', '/nope', 'still here', '/exit'],
    stdout: out.stream, stderr: err.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  assert.equal(code, 0)
  assert.match(err.text(), /mode must be one of/u)
  assert.match(out.text(), /Unknown command \/nope/u)
  assert.equal(calls.length, 1, 'a bad command does not consume a turn')
})

test('a failed turn does not end the session', async () => {
  const out = capture()
  const err = capture()
  const { calls, runtime } = turnRecorder()
  const code = await startInteractiveSession({
    options: { sessionId: 'sess-fail', mode: 'normal', cwd: '/w' },
    lines: ['explode', 'recover', '/exit'],
    stdout: out.stream, stderr: err.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.match(err.text(), /turn failed: model unavailable/u)
  assert.match(out.text(), /echo:recover/u)
})

test('interactive /plan and /approve operate on the session plan', async () => {
  const issued = issueEmailCode({ email: 'interactive@example.com' })
  const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
  upsertSession({ id: 'sess-plan', userId, title: 'Plan' })
  const plan = createGoalPlan({
    userId, sessionId: 'sess-plan', objective: 'Ship the fix', steps: [{ title: 'Reproduce' }],
  })
  const out = capture()
  const err = capture()
  const { runtime } = turnRecorder()
  const code = await startInteractiveSession({
    options: { sessionId: 'sess-plan', mode: 'normal', cwd: '/w' },
    lines: ['/plan', '/approve', '/plan', '/exit'],
    stdout: out.stream, stderr: err.stream,
    runTurn: runtime,
    resolveUserId: async () => userId,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /Ship the fix/u)
  assert.match(out.text(), /Reproduce/)
  assert.match(out.text(), /·/u)
  assert.match(out.text(), /Approved/u)
  // The plan really moved in the store, not just in the terminal.
  const { getGoalPlan } = await import('../../server/services/goalPlanService.js')
  assert.equal(getGoalPlan({ userId, planId: plan.id }).status, 'approved')
  // A second approval is a no-op error, not a crash.
  const again = capture()
  await startInteractiveSession({
    options: { sessionId: 'sess-plan', mode: 'normal', cwd: '/w' },
    lines: ['/approve', '/exit'],
    stdout: again.stream, stderr: again.stream,
    runTurn: runtime,
    resolveUserId: async () => userId,
  })
  assert.match(again.text(), /no plan awaiting approval|error/u)
  assert.equal(getGoalPlan({ userId, planId: plan.id }).status, 'approved')
})

test('approving a plan that is not awaiting approval surfaces the service error', async () => {
  const issued = issueEmailCode({ email: 'interactive2@example.com' })
  const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
  upsertSession({ id: 'sess-done', userId, title: 'Done' })
  const plan = createGoalPlan({ userId, sessionId: 'sess-done', objective: 'x', steps: [{ title: 'a' }] })
  approveGoalPlan({ userId, planId: plan.id })
  const out = capture()
  const { runtime } = turnRecorder()
  const code = await startInteractiveSession({
    options: { sessionId: 'sess-done', mode: 'normal', cwd: '/w' },
    lines: [`/approve ${plan.id}`, '/exit'],
    stdout: out.stream, stderr: out.stream,
    runTurn: runtime,
    resolveUserId: async () => userId,
  })
  assert.equal(code, 0)
  assert.match(out.text(), /cannot approve a plan in status approved/u)
})

test('chat rejects a positional prompt and --resume', async () => {
  const { cmdChat } = await import('../../bin/yma-cli.js')
  await assert.rejects(
    cmdChat({ prompt: 'hello', mode: 'normal', cwd: '/w' }),
    (error) => error instanceof CliUsageError && error.code === 'CLI_CHAT_PROMPT_CONFLICT',
  )
  await assert.rejects(
    cmdChat({ resumeTurnId: 'turn-1', mode: null, cwd: '/w' }),
    (error) => error instanceof CliUsageError && error.code === 'CLI_CHAT_RESUME_CONFLICT',
  )
})

test('the readline-backed reader consumes lines from a real stream', async () => {
  // The scripted-lines tests bypass readline; this covers the path production
  // actually uses (prompt, line, prompt, line).
  const { Readable } = await import('node:stream')
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const out = capture()
  out.stream.isTTY = true
  const { calls, runtime } = turnRecorder()
  const session = startInteractiveSession({
    options: { sessionId: 'sess-tty', mode: 'normal', cwd: '/w' },
    stdin,
    stdout: out.stream,
    stderr: out.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  stdin.push('hello from a tty\n')
  // All three lines arrive before the second question is asked: readline drops
  // lines that land with no pending question unless the reader buffers them.
  stdin.push('second prompt\n')
  stdin.push('/exit\n')
  stdin.push(null)
  assert.equal(await session, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].prompt, 'hello from a tty')
  assert.equal(calls[1].prompt, 'second prompt')
  assert.match(out.text(), /echo:hello from a tty/)
  assert.match(out.text(), /echo:second prompt/)
})

test('interactive turns get the same interaction ports as `gugo run`', async () => {
  // Regression: chat passed no onApproval/onDirectoryRequest/onSideEffectRecovery,
  // so the runtime's fail-closed default denied every approval-requiring tool.
  const out = capture()
  const { calls, runtime } = turnRecorder()
  await startInteractiveSession({
    options: { sessionId: 'sess-ports', mode: 'normal', cwd: '/w' },
    lines: ['needs approval', '/exit'],
    stdout: out.stream, stderr: out.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  assert.equal(calls.length, 1)
  for (const port of ['onApproval', 'onDirectoryRequest', 'onSideEffectRecovery']) {
    assert.equal(typeof calls[0][port], 'function', `${port} must be wired for chat too`)
  }
})

test('chat streams provisional text and resolves it once after runtime success, failure or cancel', async () => {
  for (const status of ['completed', 'failed', 'cancelled', 'throw', 'local-cancel']) {
    const out = capture()
    const err = capture()
    await startInteractiveSession({
      lines: ['prompt', '/exit'], stdout: out.stream, stderr: err.stream,
      resolveUserId: async () => 'user-1',
      runTurn: async (input) => {
        await input.onEvent({ type: 'assistant.delta', payload: { text: 'streamed answer' } })
        assert.match(out.text(), /\[assistant provisional\]\nstreamed answer/u)
        assert.doesNotMatch(out.text(), /assistant confirmed/u)
        if (status === 'throw') throw new Error('fixture failed')
        if (status === 'local-cancel') {
          process.emit('SIGINT')
          throw input.signal.reason
        }
        await input.onEvent({ type: `turn.${status}`, payload: { text: 'streamed answer' } })
        return { status, exitCode: status === 'completed' ? 0 : 1 }
      },
    })
    assert.equal(out.text().split('streamed answer').length - 1, 1)
    assert.match(out.text(), status === 'completed' ? /\[assistant confirmed\]/u : /\[assistant not confirmed\]/u)
    if (status !== 'completed') assert.doesNotMatch(err.text(), /turn completed/u)
  }
})

test('interactive turns release output listeners after success, failure and cancellation', async () => {
  const out = capture()
  const err = capture()
  const baseline = [out.stream, err.stream].map((stream) => ({
    error: stream.listenerCount('error'), close: stream.listenerCount('close'),
  }))
  const prompts = ['success', 'failure', 'cancel']
  await startInteractiveSession({
    options: { sessionId: 'sess-listeners', mode: 'normal', cwd: '/w' },
    lines: [...prompts, '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1',
    runTurn: async (input) => {
      for (const [index, stream] of [out.stream, err.stream].entries()) {
        assert.equal(stream.listenerCount('error'), baseline[index].error + 1)
        assert.equal(stream.listenerCount('close'), baseline[index].close + 1)
      }
      if (input.prompt === 'failure') throw new Error('synthetic failure')
      if (input.prompt === 'cancel') {
        process.emit('SIGINT')
        throw input.signal.reason
      }
      await input.onEvent({ type: 'turn.completed', payload: { text: 'done' } })
      return { status: 'completed', exitCode: 0, sessionId: input.sessionId }
    },
  })
  for (const [index, stream] of [out.stream, err.stream].entries()) {
    assert.equal(stream.listenerCount('error'), baseline[index].error)
    assert.equal(stream.listenerCount('close'), baseline[index].close)
  }
  assert.match(err.text(), /synthetic failure/u)
  assert.match(err.text(), /turn cancelled/u)
})

test('interactive cancellation request does not claim cancellation before the runtime settles', async () => {
  const out = capture()
  const err = capture()
  await startInteractiveSession({
    options: { sessionId: 'cancel-completion-race', mode: 'normal', cwd: '/w' },
    lines: ['finish', '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1',
    runTurn: async (input) => {
      process.emit('SIGINT')
      process.emit('SIGINT')
      assert.equal(input.signal.aborted, true)
      assert.match(err.text(), /cancellation requested/u)
      assert.doesNotMatch(err.text(), /turn cancelled|Press Ctrl-C again/u)
      await input.onEvent({ type: 'turn.completed', payload: { text: 'already completed' } })
      return { status: 'completed', exitCode: 0, sessionId: input.sessionId }
    },
  })
  assert.match(out.text(), /already completed/u)
  assert.match(err.text(), /turn completed/u)
  assert.doesNotMatch(err.text(), /turn cancelled/u)
})

test('interactive cancellation preserves unrelated errors and stops queued prompts', async () => {
  const failures = [
    Object.assign(new Error('shutdown failed'), { code: 'HEADLESS_RUNTIME_SHUTDOWN_FAILED' }),
    Object.assign(new Error('cancellation persistence failed'), { code: 'TURN_PERSISTENCE_FAILED' }),
    Object.assign(new Error('unrelated abort'), { name: 'AbortError', code: 'ABORT_ERR' }),
    new Error('uncoded cleanup failure'),
  ]
  for (const failure of failures) {
    const out = capture()
    const err = capture()
    let calls = 0
    const listenersBefore = process.listenerCount('SIGINT')
    await assert.rejects(startInteractiveSession({
      options: { sessionId: 'cancel-failure', mode: 'normal', cwd: '/w' },
      lines: ['cancel', 'must not run', '/exit'], stdout: out.stream, stderr: err.stream,
      resolveUserId: async () => 'user-1',
      runTurn: async (input) => {
        calls += 1
        process.emit('SIGINT')
        await input.onEvent({ type: 'turn.completed', payload: { text: 'must not commit' } })
        throw failure
      },
    }), (error) => error === failure)
    assert.equal(calls, 1)
    assert.equal(out.text().includes('must not commit'), false)
    assert.doesNotMatch(err.text(), /turn cancelled/u)
    assert.equal(process.listenerCount('SIGINT'), listenersBefore)
    for (const stream of [out.stream, err.stream]) {
      assert.equal(stream.listenerCount('error'), 0)
      assert.equal(stream.listenerCount('close'), 0)
    }
  }
})

test('interactive cancellation preserves aggregate failures even with the cancellation reason inside', async () => {
  const out = capture()
  const err = capture()
  let failure
  await assert.rejects(startInteractiveSession({
    options: { sessionId: 'cancel-aggregate', mode: 'normal', cwd: '/w' },
    lines: ['cancel', '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1',
    runTurn: async (input) => {
      process.emit('SIGINT')
      failure = Object.assign(new AggregateError([
        input.signal.reason, new Error('shutdown failed'),
      ], 'execution and shutdown failed'), { code: 'HEADLESS_TURN_AND_SHUTDOWN_FAILED' })
      throw failure
    },
  }), (error) => error === failure)
  assert.doesNotMatch(err.text(), /turn cancelled/u)
})

test('interactive cancellation displays a returned cancelled terminal rather than success', async () => {
  const out = capture()
  const err = capture()
  await startInteractiveSession({
    options: { sessionId: 'cancel-terminal', mode: 'normal', cwd: '/w' },
    lines: ['cancel', '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1',
    runTurn: async (input) => {
      process.emit('SIGINT')
      await input.onEvent({ type: 'turn.cancelled', payload: { text: 'partial answer' } })
      return { status: 'cancelled', exitCode: 1, sessionId: input.sessionId }
    },
  })
  assert.match(err.text(), /turn cancelled in/u)
  assert.doesNotMatch(out.text(), /partial answer/u)
})

test('interactive cancellation permits another prompt only after cooperative local abort', async () => {
  const out = capture()
  const err = capture()
  const seen = []
  await startInteractiveSession({
    options: { sessionId: 'cancel-continue', mode: 'normal', cwd: '/w' },
    lines: ['cancel', 'continue', '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1',
    runTurn: async (input) => {
      seen.push(input.prompt)
      if (input.prompt === 'cancel') {
        process.emit('SIGINT')
        throw input.signal.reason
      }
      await input.onEvent({ type: 'turn.completed', payload: { text: 'next turn completed' } })
      return { status: 'completed', exitCode: 0, sessionId: input.sessionId }
    },
  })
  assert.deepEqual(seen, ['cancel', 'continue'])
  assert.equal((err.text().match(/\[turn cancelled\]/gu) || []).length, 1)
  assert.match(out.text(), /next turn completed/u)
})

test('interactive cancellation does not absorb an externally aborted session failure', async () => {
  const parent = new AbortController()
  const out = capture()
  const err = capture()
  const failure = Object.assign(new Error('external shutdown failed'), { code: 'HEADLESS_RUNTIME_SHUTDOWN_FAILED' })
  let calls = 0
  await assert.rejects(startInteractiveSession({
    options: { sessionId: 'cancel-external', mode: 'normal', cwd: '/w' },
    lines: ['cancel', 'must not run', '/exit'], signal: parent.signal,
    stdout: out.stream, stderr: err.stream, resolveUserId: async () => 'user-1',
    runTurn: async () => {
      calls += 1
      parent.abort(new Error('session stopped'))
      throw failure
    },
  }), (error) => error === failure)
  assert.equal(calls, 1)
  assert.doesNotMatch(err.text(), /turn cancelled/u)
})

test('interactive cancellation preserves a failed terminal while cleanup is pending', { timeout: 5000 }, async (t) => {
  const out = capture()
  const err = capture()
  const phases = []
  const terminalReady = Promise.withResolvers()
  const cleanup = Promise.withResolvers()
  const lastEvent = { type: 'turn.failed', payload: { code: 'MODEL_FAILED', text: 'partial response' } }
  const session = startInteractiveSession({
    options: { sessionId: 'failed-before-cancel', mode: 'normal', cwd: '/w' },
    lines: ['fail', '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1',
    runTurn: async (input) => {
      await input.onEvent(lastEvent)
      phases.push('failed terminal delivered')
      terminalReady.resolve()
      await cleanup.promise
      phases.push('cleanup settled')
      return { status: 'failed', exitCode: 1, lastEvent, sessionId: input.sessionId }
    },
  })
  try {
    await Promise.race([terminalReady.promise, session.then(() => { throw new Error('runtime ended before terminal') })])
    process.emit('SIGINT')
    phases.push('cancellation requested')
    assert.match(err.text(), /cancellation requested/u)
    assert.doesNotMatch(err.text(), /turn cancelled/u)
  } finally {
    cleanup.resolve()
    await session
  }
  t.diagnostic(phases.join(' -> '))
  assert.deepEqual(phases, ['failed terminal delivered', 'cancellation requested', 'cleanup settled'])
  assert.match(err.text(), /MODEL_FAILED/u)
  assert.match(err.text(), /turn failed in/u)
  assert.doesNotMatch(err.text(), /turn cancelled/u)
  assert.doesNotMatch(out.text(), /partial response/u)
})

test('/new works without an injected id generator', async () => {
  const out = capture()
  const { calls, runtime } = turnRecorder({ sessionId: 'ignored' })
  const code = await startInteractiveSession({
    options: { mode: 'normal', cwd: '/w' },
    lines: ['/new', 'after new', '/exit'],
    stdout: out.stream, stderr: out.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  assert.equal(code, 0)
  assert.match(out.text(), /Started a new session/u)
  assert.doesNotMatch(out.text(), /unavailable/u)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sessionId, /^[0-9a-f-]{36}$/u, 'a real session id was generated')
})

test('idle terminal Ctrl-C warns once then exits and releases stdin', { timeout: 5000 }, async () => {
  const { Readable } = await import('node:stream')
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const prompted = Promise.withResolvers()
  const warned = Promise.withResolvers()
  const out = new Writable({ write(chunk, _encoding, done) {
    if (String(chunk).includes('idle-sig>')) prompted.resolve()
    if (String(chunk).includes('Press Ctrl-C again')) warned.resolve()
    done()
  } })
  out.isTTY = true
  const baseline = process.listenerCount('SIGINT')
  const session = startInteractiveSession({
    options: { sessionId: 'idle-signal-session' }, stdin, stdout: out, stderr: out,
    resolveUserId: async () => 'user-1', runTurn: async () => { assert.fail('must not run a turn') },
  })
  try {
    await prompted.promise
    stdin.push('\u0003')
    await Promise.race([warned.promise, session.then(() => assert.fail('first Ctrl-C must not exit'))])
    stdin.push('\u0003')
    assert.equal(await session, 0)
    assert.equal(stdin.isPaused(), true)
    assert.equal(process.listenerCount('SIGINT'), baseline)
  } finally {
    stdin.push('/exit\n')
    stdin.push(null)
    await session
  }
})

function terminalHarness(runTurn) {
  const previousTerm = process.env.TERM
  // A simulated cursor-capable TTY must not inherit the runner's TERM=dumb.
  process.env.TERM = 'xterm-256color'
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const out = capture()
  const err = capture()
  out.stream.isTTY = true
  err.stream.isTTY = true
  const prompts = []
  const waiters = []
  const originalWrite = out.stream._write.bind(out.stream)
  out.stream._write = (chunk, encoding, done) => {
    originalWrite(chunk, encoding, done)
    if (String(chunk) === 'tty-test> ' || String(chunk) === 'draft> ') {
      if (waiters.length) waiters.shift()()
      else prompts.push(true)
    }
  }
  const session = startInteractiveSession({
    options: { sessionId: 'tty-test' }, stdin, stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'user-1', runTurn,
  })
  return {
    stdin, out, err, session,
    async prompt() {
      if (prompts.length) prompts.shift()
      else await new Promise((resolve) => waiters.push(resolve))
    },
    async close() {
      try { stdin.push('/exit\n'); stdin.push(null); await session }
      finally {
        if (previousTerm === undefined) delete process.env.TERM
        else process.env.TERM = previousTerm
      }
    },
  }
}

test('real readline Up history survives turn suspension and approval rebuilding', { timeout: 5000 }, async () => {
  const seen = []
  let secondTurnStarted
  const secondTurn = new Promise((resolve) => { secondTurnStarted = resolve })
  let tty
  tty = terminalHarness(async (input) => {
    seen.push(input.prompt)
    if (seen.length === 2) secondTurnStarted()
    if (seen.length === 1) {
      const approval = input.onApproval({ payload: { toolName: 'fixture' } })
      tty.stdin.push('n\n')
      assert.deepEqual(await approval, { decision: 'deny' })
    }
    await input.onEvent({ type: 'turn.completed', payload: { text: 'done' } })
    return { status: 'completed', exitCode: 0 }
  })
  try {
    await tty.prompt()
    tty.stdin.push('remember this prompt\n')
    await tty.prompt()
    tty.stdin.push('\u001b[A\n')
    // Up redraws the current prompt before Enter reaches the runtime. Await the
    // actual second turn, not a terminal repaint that merely looks like readiness.
    await secondTurn
    assert.deepEqual(seen, ['remember this prompt', 'remember this prompt'])
  } finally { await tty.close() }
})

test('multiline draft groups pasted lines into one turn and preserves blank lines', { timeout: 5000 }, async () => {
  const { calls, runtime } = turnRecorder()
  const tty = terminalHarness(runtime)
  try {
    await tty.prompt()
    tty.stdin.push('/draft\nfirst line\n\n/mode bypass\nlast line\n/send\n')
    while (!calls.length) await tty.prompt()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].prompt, 'first line\n\n/mode bypass\nlast line')
    assert.equal(calls[0].mode, 'normal')
  } finally { await tty.close() }
})

test('draft discard, undo, empty send and EOF never submit accidental turns', async () => {
  const { calls, runtime } = turnRecorder()
  const out = capture()
  await startInteractiveSession({
    lines: ['/draft', '/send', 'discard me', '/discard', '/draft', 'keep', 'remove', '/undo', '//send', '/send', '/draft', 'unfinished'],
    stdout: out.stream, stderr: out.stream, resolveUserId: async () => 'user-1', runTurn: runtime,
  })
  assert.deepEqual(calls.map((input) => input.prompt), ['keep\n/send'])
  assert.match(out.text(), /Draft is empty/u)
  assert.match(out.text(), /Draft discarded/u)
})

test('real draft Ctrl-C discards without running or leaking lines into approval', { timeout: 5000 }, async () => {
  const tty = terminalHarness(async () => assert.fail('discarded draft must not run'))
  try {
    await tty.prompt()
    tty.stdin.push('/draft\n')
    await tty.prompt()
    tty.stdin.push('not a turn\n')
    await tty.prompt()
    tty.stdin.push('\u0003')
    await tty.prompt()
    assert.match(tty.err.text(), /Draft discarded/u)
  } finally { await tty.close() }
})

test('input buffered while the chat reader is suspended cannot approve a tool', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  const asked = Promise.withResolvers()
  let decision
  const tty = terminalHarness(async (input) => {
    entered.resolve()
    await proceed.promise
    const approval = input.onApproval({ payload: { toolName: 'fixture' } })
    asked.resolve()
    decision = await approval
    return { status: 'blocked', exitCode: 1 }
  })
  try {
    await tty.prompt()
    tty.stdin.push('needs approval\n')
    await entered.promise
    tty.stdin.push('y\n')
    proceed.resolve()
    await asked.promise
    tty.stdin.push('n\n')
    await tty.prompt()
    assert.deepEqual(decision, { decision: 'deny' })
  } finally { proceed.resolve(); await tty.close() }
})

test('/exit releases stdin instead of waiting for EOF', async () => {
  const { Readable } = await import('node:stream')
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const out = capture()
  out.stream.isTTY = true
  const { runtime } = turnRecorder()
  const session = startInteractiveSession({
    options: { sessionId: 'sess-exit', mode: 'normal', cwd: '/w' },
    stdin, stdout: out.stream, stderr: out.stream,
    runTurn: runtime,
    resolveUserId: async () => 'user-1',
  })
  stdin.push('/exit\n')
  // No end-of-stream: the session must still finish and drop its reader.
  assert.equal(await session, 0)
  // readline keeps an internal keypress listener in terminal mode, so the
  // meaningful invariant is that stdin is released (paused) rather than still
  // being read: that is what lets the process exit without EOF.
  assert.equal(stdin.isPaused(), true, 'stdin is released after /exit')
  stdin.push(null)
})

test('Tab completion offers slash commands and leaves non-commands alone', () => {
  assert.deepEqual(completeInteractiveLine('', {}), [[], ''])
  assert.deepEqual(completeInteractiveLine('plain prompt text', {}), [[], ''])
  assert.deepEqual(completeInteractiveLine('/h', {}), [['/help'], '/h'])
  assert.deepEqual(completeInteractiveLine('/mo', {}), [['/model', '/mode'], '/mo'])
  assert.deepEqual(completeInteractiveLine('/help ', {}), [[], ''])
  assert.deepEqual(completeInteractiveLine('/unknown arg', {}), [[], ''])
  assert.deepEqual(completeInteractiveLine('/HELP', {}), [['/help'], '/HELP'], 'command matching is case-insensitive')
})

test('every advertised command is actually completable', () => {
  const hits = completeInteractiveLine('/', {})[0]
  assert.deepEqual(hits, INTERACTIVE_COMMANDS.map((entry) => entry.name))
})

test('Tab completion resolves declared argument sources and never rewrites past the first argument', () => {
  assert.deepEqual(completeInteractiveLine('/mode ', {}), [[...INTERACTIVE_MODES], ''])
  assert.deepEqual(completeInteractiveLine('/mode ac', {}), [['acceptEdits'], 'ac'])
  assert.deepEqual(completeInteractiveLine('/mode normal', {}), [['normal'], 'normal'])
  assert.deepEqual(completeInteractiveLine('/mode normal ', {}), [[], ''], 'a second argument is left untouched')

  const sources = { listSessions: () => ['sess-alpha', 'sess-beta'] }
  assert.deepEqual(completeInteractiveLine('/session sess-', sources), [['sess-alpha', 'sess-beta'], 'sess-'])
  assert.deepEqual(completeInteractiveLine('/resume sess-beta', sources), [['sess-beta'], 'sess-beta'])
  assert.deepEqual(completeInteractiveLine('/session other', sources), [[], 'other'])
  assert.deepEqual(completeInteractiveLine('/model ', {}), [[], ''], 'a command without a source offers nothing')
})

test('a failing completion source degrades to no candidates instead of breaking the prompt', () => {
  const sources = {
    listSessions: () => { throw new Error('session store offline') },
  }
  assert.deepEqual(completeInteractiveLine('/session ', sources), [[], ''], 'empty argument, no candidates')
  assert.deepEqual(completeInteractiveLine('/resume a', sources), [[], 'a'], 'the argument tail is echoed back unchanged')
})

test('persisted history drops blanks and space-prefixed secrets, and stays bounded', () => {
  assert.equal(isRecordableHistoryLine(''), false)
  assert.equal(isRecordableHistoryLine('   '), false)
  assert.equal(isRecordableHistoryLine(' /model sk-secret'), false, 'a leading space keeps a line out of history')
  assert.equal(isRecordableHistoryLine('/model gpt-5'), true)

  let entries = []
  entries = appendInteractiveHistory(entries, 'first')
  entries = appendInteractiveHistory(entries, '')
  entries = appendInteractiveHistory(entries, ' first')
  entries = appendInteractiveHistory(entries, 'first')
  entries = appendInteractiveHistory(entries, 'second')
  assert.deepEqual(entries, ['first', 'second'], 'blank, space-prefixed and consecutive-duplicate input is skipped')

  assert.deepEqual(appendInteractiveHistory(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd'])
  assert.deepEqual(appendInteractiveHistory(null, 'a'), ['a'])
  assert.deepEqual(appendInteractiveHistory(['a'], 'b', 0), [])
})

test('history parsing tolerates CRLF, blank lines and junk', () => {
  assert.deepEqual(parseInteractiveHistory('one\r\ntwo\n\nthree\n'), ['one', 'two', 'three'])
  assert.deepEqual(parseInteractiveHistory(''), [])
  assert.deepEqual(parseInteractiveHistory(null), [])
  assert.deepEqual(parseInteractiveHistory('a\nb\nc', 2), ['b', 'c'])
})

test('history round-trips through a real file and never throws on an unreadable path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-history-'))
  const file = resolveInteractiveHistoryPath(dir)
  assert.equal(path.basename(file), 'cli-history')

  assert.deepEqual(readInteractiveHistory(file), [], 'a missing file yields no entries')
  writeInteractiveHistory(file, ['alpha', 'beta'])
  assert.deepEqual(readInteractiveHistory(file), ['alpha', 'beta'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'alpha\nbeta\n')

  writeInteractiveHistory(file, [])
  assert.deepEqual(readInteractiveHistory(file), [])

  // A directory where the file should be must not throw on read or write.
  const blocked = path.join(dir, 'blocked')
  fs.mkdirSync(blocked)
  assert.deepEqual(readInteractiveHistory(blocked), [])
  writeInteractiveHistory(blocked, ['x'])

  assert.equal(resolveInteractiveHistoryPath(null), null)
  assert.equal(resolveInteractiveHistoryPath(''), null)
  assert.deepEqual(readInteractiveHistory(null), [])
  writeInteractiveHistory(null, ['x'])
  assert.deepEqual(readInteractiveHistory(path.join(dir, 'no-such-file')), [])

  fs.rmSync(dir, { recursive: true, force: true })
})

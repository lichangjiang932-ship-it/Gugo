import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { getEventListeners, once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { createReadlineInputEditor } from '../../bin/cli/input/readlineInputAdapter.js'
import { resolveInteractiveHistoryPath, writeInteractiveHistory } from '../../bin/cli/interactiveHistory.js'

function terminal(t, onWrite = () => {}) {
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const stdout = new Writable({ write(chunk, _encoding, done) { onWrite(String(chunk), stdin); done() } })
  stdout.isTTY = true
  const editor = createReadlineInputEditor({ stdin, stdout, historyFile: null, onSigint() {} })
  t.after(() => { editor.close(); stdin.destroy(); stdout.destroy() })
  return { stdin, stdout, editor }
}

test('readline preserves complete early lines across suspend but not the unfinished draft', async (t) => {
  const { stdin, editor } = terminal(t)
  stdin.push('first queued\nsecond queued\nunfinished draft')
  await nextTurn()
  assert.equal(await editor.question('first> '), 'first queued')
  editor.suspend()
  assert.equal(await editor.question('second> '), 'second queued')
  const fresh = editor.question('third> ')
  stdin.push('fresh third\n')
  assert.equal(await fresh, 'fresh third')
})

test('readline drains only unowned handoff input and accepts a valid line arriving during prompt output', async (t) => {
  let injected = false
  const { stdin, editor } = terminal(t, (chunk, input) => {
    if (chunk.includes('fresh> ') && !injected) { injected = true; input.push('valid new task\n') }
  })
  const prior = editor.question('old> ')
  const typed = once(stdin, 'keypress')
  stdin.push('cancelled draft')
  await typed
  editor.suspend()
  assert.equal(await prior, null)
  stdin.push('y\npermission answer\n')
  assert.equal(await editor.question('fresh> '), 'valid new task')
  assert.equal(injected, true)
})

test('readline request abort after a completed submission cannot cancel the next question', async (t) => {
  const { stdin, editor } = terminal(t)
  const controller = new AbortController()
  const first = editor.question('first> ', { signal: controller.signal })
  stdin.push('first\n')
  assert.equal(await first, 'first')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const second = editor.question('second> ')
  controller.abort()
  stdin.push('second\n')
  assert.equal(await second, 'second')
})

test('a pre-aborted readline request leaves already-submitted queued lines available', async (t) => {
  const { stdin, editor } = terminal(t)
  stdin.push('queued task\n')
  await nextTurn()
  const controller = new AbortController()
  controller.abort()
  const aborted = editor.question('cancelled> ', { signal: controller.signal })
  assert.equal(await aborted, null)
  assert.equal(await editor.question('active> '), 'queued task')
})

test('readline EOF drains submitted complete lines but never reopens or submits the final draft', async (t) => {
  const { stdin, editor } = terminal(t)
  stdin.push('first complete\nsecond complete\nunfinished')
  stdin.push(null)
  await nextTurn()
  assert.equal(await editor.question('first> '), 'first complete')
  editor.suspend()
  assert.equal(await editor.question('second> '), 'second complete')
  assert.equal(await editor.question('ended> '), null)
  assert.equal(stdin.listenerCount('keypress'), 0)
  editor.suspend()
  assert.equal(await editor.question('still ended> '), null)
})

test('readline restores persisted history on a new instance and close remains permanent after suspend', async () => {
  const previousTerm = process.env.TERM
  process.env.TERM = 'xterm-256color'
  const directory = mkdtempSync(path.join(tmpdir(), 'cli-history-restart-'))
  const input = new Readable({ read() {} })
  input.isTTY = true
  const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  output.isTTY = true
  const historyFile = resolveInteractiveHistoryPath(directory, { userId: 'owner' })
  assert.notEqual(historyFile, resolveInteractiveHistoryPath(directory, { userId: 'other' }))
  writeInteractiveHistory(historyFile, ['older entry', 'most recent entry'])
  const editor = createReadlineInputEditor({ stdin: input, stdout: output, historyFile, onSigint() {} })
  try {
    const pending = editor.question('history> ')
    input.push('\u001b[A\n')
    assert.equal(await pending, 'most recent entry')
    editor.suspend()
    editor.close()
    assert.equal(await editor.question('must not reopen> '), null)
    assert.equal(input.listenerCount('keypress'), 0, 'no editor still owns decoded keystrokes')
    assert.equal(input.isPaused(), true, 'readline may retain its reusable decoder, but no reader is flowing')
  } finally {
    if (previousTerm === undefined) delete process.env.TERM
    else process.env.TERM = previousTerm
    editor.close()
    input.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

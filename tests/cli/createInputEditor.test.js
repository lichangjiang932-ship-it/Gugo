import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable, Writable } from 'node:stream'
import { createInteractiveInputEditor } from '../../bin/cli/input/createInputEditor.js'

const reader = () => ({ question: async () => '', clear() {}, suspend() {}, close() {} })

test('readline and legacy auto alias never load Ink on any TTY or Node version', () => {
  for (const mode of [undefined, 'readline', 'auto', ' AUTO ', '  ']) {
    for (const nodeVersion of ['20.19.0', '22.20.0']) {
      const expected = reader()
      const result = createInteractiveInputEditor({ stdin: { isTTY: true }, stdout: { isTTY: true } }, { env: { GUGO_CLI_INPUT: mode }, nodeVersion,
        readlineFactory: () => expected, inkFactory: () => assert.fail('Ink must stay lazy') })
      assert.equal(result, expected)
    }
  }
  assert.throws(() => createInteractiveInputEditor({}, { env: { GUGO_CLI_INPUT: 'invalid' } }), { code: 'CLI_INPUT_MODE_INVALID' })
  assert.throws(() => createInteractiveInputEditor({}, { env: { GUGO_CLI_INPUT: 'ink' }, nodeVersion: '20.19.0' }), { code: 'CLI_INK_NODE_UNSUPPORTED' })
})

test('Ink draft cancellation uses the same two-interrupt policy without submitting or replaying text', async () => {
  let interrupted = 0
  let mounts = 0
  let closes = 0
  let input
  input = createInteractiveInputEditor({ stdin: {}, onSigint() { interrupted++; if (interrupted === 2) input.close() } }, {
    env: { GUGO_CLI_INPUT: 'ink' }, nodeVersion: '22.20.0',
    inkFactory: ({ onKeyboardCancel }) => ({ ...reader(), question: async () => {
      mounts++; onKeyboardCancel?.(); return null
    }, close() { closes++ } }),
  })
  assert.equal(await input.question('> '), null)
  assert.equal(interrupted, 2)
  assert.equal(mounts, 2)
  assert.equal(closes, 1)
})

test('Ink renderer errors do not silently retry or fall back after an uncertain submission', async () => {
  let calls = 0
  const failure = new Error('render failure')
  const input = createInteractiveInputEditor({}, { env: { GUGO_CLI_INPUT: 'ink' },
    nodeVersion: '22.20.0',
    inkFactory: () => ({ ...reader(), question: async () => { calls++; throw failure } }),
    readlineFactory: () => assert.fail('never replay a failed submission'),
  })
  await assert.rejects(input.question('> '), (error) => error === failure)
  assert.equal(calls, 1)
})

test('Ink EOF or a non-keyboard null never triggers Ctrl-C policy or silently remounts', async () => {
  let calls = 0
  let interrupts = 0
  let input
  input = createInteractiveInputEditor({ onSigint() { interrupts++; input.close() } }, {
    env: { GUGO_CLI_INPUT: 'ink' }, nodeVersion: '22.20.0',
    inkFactory: () => ({ ...reader(), question: async () => { calls++; return null } }),
  })
  assert.equal(await input.question('> '), null)
  assert.equal(calls, 1)
  assert.equal(interrupts, 0)
})

test('Ink wrapper clear during keyboard cancellation settles empty instead of reopening the old prompt', async () => {
  let calls = 0
  let input
  input = createInteractiveInputEditor({ onSigint() { input.clear() } }, {
    env: { GUGO_CLI_INPUT: 'ink' }, nodeVersion: '22.20.0',
    inkFactory: ({ onKeyboardCancel }) => ({ ...reader(), question: async () => {
      calls++
      if (calls > 1) return 'must not reopen'
      onKeyboardCancel?.()
      return null
    } }),
  })
  assert.equal(await input.question('draft> '), '')
  assert.equal(calls, 1)
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function realInkWrapper(t, signal) {
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (value) => { stdin.isRaw = value }
  const stdout = new Writable({ write(_chunk, _encoding, done) { done() } })
  stdout.isTTY = true
  let mounting
  let interrupts = 0
  let mounts = 0
  const editor = createInteractiveInputEditor({ stdin, stdout, stderr: stdout, signal,
    onSigint() { interrupts++; if (interrupts >= 2) editor.close() },
    loadRenderer: async () => (props) => {
      mounts++
      const exited = deferred()
      stdin.setRawMode(true)
      mounting.resolve({ props, exit: exited.resolve })
      return { cleanup: exited.resolve, waitUntilExit: () => exited.promise }
    },
  }, { env: { GUGO_CLI_INPUT: 'ink' }, nodeVersion: '22.20.0' })
  t.after(() => { editor.close(); stdin.destroy(); stdout.destroy() })
  return {
    editor, stdin, interrupts: () => interrupts, mounts: () => mounts,
    ask(request) {
      mounting = deferred()
      return { result: editor.question('> ', request), ready: mounting.promise }
    },
  }
}

test('Ink factory forwards request abort without invoking Ctrl-C and permits a fresh question', async (t) => {
  const io = realInkWrapper(t)
  const controller = new AbortController()
  const first = io.ask({ signal: controller.signal })
  const oldRenderer = await first.ready
  controller.abort()
  assert.equal(await first.result, null)
  oldRenderer.props.onCancel()
  assert.equal(io.interrupts(), 0)
  assert.equal(io.stdin.isRaw, false)
  const next = io.ask()
  const current = await next.ready
  current.props.onSubmit('fresh')
  assert.equal(await next.result, 'fresh')
  assert.equal(io.mounts(), 2)
})

test('Ink factory constructor abort stays permanent and never triggers Ctrl-C', async (t) => {
  const controller = new AbortController()
  const io = realInkWrapper(t, controller.signal)
  const first = io.ask()
  await first.ready
  controller.abort()
  assert.equal(await first.result, null)
  assert.equal(await io.editor.question('closed> '), null)
  assert.equal(io.interrupts(), 0)
  assert.equal(io.mounts(), 1)
})

test('Ink factory suspend releases the current question without invoking keyboard cancellation', async (t) => {
  const io = realInkWrapper(t)
  const first = io.ask()
  await first.ready
  io.editor.suspend()
  assert.equal(await first.result, null)
  assert.equal(io.interrupts(), 0)
  const second = io.ask()
  ;(await second.ready).props.onSubmit('after suspension')
  assert.equal(await second.result, 'after suspension')
})

test('Ink factory EOF does not mount again or warn as if Ctrl-C was pressed', async (t) => {
  const io = realInkWrapper(t)
  const pending = io.ask()
  await pending.ready
  io.stdin.emit('end')
  assert.equal(await pending.result, null)
  assert.equal(await io.editor.question('after EOF> '), null)
  assert.equal(io.interrupts(), 0)
  assert.equal(io.mounts(), 1)
})

test('Ink factory rejects concurrent questions and does not replay an unexpected renderer exit', async (t) => {
  const io = realInkWrapper(t)
  const pending = io.ask()
  const renderer = await pending.ready
  await assert.rejects(io.editor.question('concurrent> '), { code: 'CLI_INPUT_BUSY' })
  const rejected = assert.rejects(pending.result, { code: 'CLI_INK_RENDER_FAILED' })
  renderer.exit()
  await rejected
  assert.equal(io.interrupts(), 0)
  assert.equal(io.mounts(), 1)
  assert.equal(io.stdin.isRaw, false)
})

test('invalid input mode errors identify canonical modes and the explicit legacy auto alias', () => {
  assert.throws(() => createInteractiveInputEditor({}, { env: { GUGO_CLI_INPUT: 'automatic' } }), (error) => (
    error.code === 'CLI_INPUT_MODE_INVALID' && /readline or ink; legacy auto is an alias for readline/u.test(error.message)
  ))
})

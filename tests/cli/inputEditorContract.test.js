import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'

import { createReadlineInputEditor } from '../../bin/cli/input/readlineInputAdapter.js'
import { createInkInputEditor } from '../../bin/cli/input/inkInputAdapter.js'
import { createEditorState } from '../../bin/cli/input/editorModel.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t, kind, options = {}) {
  const previousTerm = process.env.TERM
  process.env.TERM = 'xterm-256color'
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (raw) => { stdin.isRaw = raw }
  const stdout = new Writable({ write(_chunk, _encoding, done) { done() } })
  stdout.isTTY = true
  let mounted = null
  let mounting = null
  const loadRenderer = async () => (props) => {
    const exited = deferred()
    mounted = { props, exit: exited.resolve }
    stdin.setRawMode(true)
    mounting?.resolve(mounted)
    return { cleanup: () => exited.resolve(), waitUntilExit: () => exited.promise }
  }
  const create = kind === 'readline' ? createReadlineInputEditor : createInkInputEditor
  const editor = create({ stdin, stdout, stderr: stdout, onSigint() {}, historyFile: null,
    nodeVersion: '22.20.0', loadRenderer, ...options })
  t.after(() => {
    editor.close(); stdin.destroy(); stdout.destroy()
    if (previousTerm === undefined) delete process.env.TERM
    else process.env.TERM = previousTerm
  })
  return {
    editor, stdin, stdout,
    ask(request) {
      mounting = deferred()
      const observed = { settled: false }
      const promise = editor.question('fixture> ', request)
      promise.then((value) => Object.assign(observed, { settled: true, value }),
        (error) => Object.assign(observed, { settled: true, error }))
      return { observed, promise, ready: kind === 'ink' ? mounting.promise : Promise.resolve() }
    },
    async draft(value) {
      if (kind === 'ink') mounted.props.onStateChange(createEditorState({ text: value }))
      else {
        const received = once(stdin, 'keypress')
        stdin.push(value)
        await received
      }
    },
    submit(value) {
      if (kind === 'ink') mounted.props.onSubmit(value)
      else stdin.push(`${value}\n`)
    },
    draftText: () => mounted?.props.initialState.lines.join('\n'),
  }
}

function assertReleased(io) {
  assert.equal(io.stdin.isRaw, false)
  assert.equal(io.stdin.listenerCount('keypress'), 0)
  assert.notEqual(io.stdin.readableFlowing, true, 'an unclaimed stream may be untouched or explicitly paused')
}

for (const kind of ['readline', 'ink']) {
  test(`${kind}: request abort settles null, releases its listener/owner, and the next question starts empty`, async (t) => {
    const io = fixture(t, kind)
    const controller = new AbortController()
    const first = io.ask({ signal: controller.signal })
    await first.ready
    await io.draft('unsubmitted old task')
    controller.abort()
    await nextTurn()
    assert.equal(first.observed.settled, true)
    assert.equal(await first.promise, null)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assertReleased(io)
    const next = io.ask()
    await next.ready
    if (kind === 'ink') assert.equal(io.draftText(), '')
    io.submit('fresh task')
    assert.equal(await next.promise, 'fresh task')
  })

  test(`${kind}: constructor abort is permanent, including when no question is pending`, async (t) => {
    const controller = new AbortController()
    const io = fixture(t, kind, { signal: controller.signal })
    const first = io.ask()
    await first.ready
    io.submit('complete')
    assert.equal(await first.promise, 'complete')
    controller.abort()
    await nextTurn()
    assertReleased(io)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    const after = io.ask()
    await nextTurn()
    assert.equal(after.observed.settled, true)
    assert.equal(await after.promise, null)
  })

  test(`${kind}: a concurrent question rejects busy without overwriting the first`, async (t) => {
    const io = fixture(t, kind)
    const first = io.ask()
    await first.ready
    const second = io.ask()
    await nextTurn()
    assert.equal(second.observed.error?.code, 'CLI_INPUT_BUSY')
    const preAborted = new AbortController()
    preAborted.abort()
    const conflicting = io.ask({ signal: preAborted.signal })
    await nextTurn()
    assert.equal(conflicting.observed.error?.code, 'CLI_INPUT_BUSY')
    io.submit('first owner')
    assert.equal(await first.promise, 'first owner')
    const third = io.ask()
    await third.ready
    io.submit('next owner')
    assert.equal(await third.promise, 'next owner')
  })

  test(`${kind}: constructor abort during a draft releases ownership and never reopens`, async (t) => {
    const controller = new AbortController()
    const io = fixture(t, kind, { signal: controller.signal })
    const pending = io.ask()
    await pending.ready
    await io.draft('interrupted draft')
    controller.abort()
    assert.equal(await pending.promise, null)
    assertReleased(io)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(await io.editor.question('later> '), null)
  })

  test(`${kind}: request abort wins over a late submission without polluting the next question`, async (t) => {
    const io = fixture(t, kind)
    const controller = new AbortController()
    const pending = io.ask({ signal: controller.signal })
    await pending.ready
    controller.abort()
    io.submit('late old task')
    assert.equal(await pending.promise, null)
    const next = io.ask()
    await next.ready
    io.submit('explicit next task')
    assert.equal(await next.promise, 'explicit next task')
  })

  test(`${kind}: suspend settles null and discards an unfinished draft without closing permanently`, async (t) => {
    const io = fixture(t, kind)
    const first = io.ask()
    await first.ready
    await io.draft('must not survive suspension')
    io.editor.suspend()
    assert.equal(await first.promise, null)
    assertReleased(io)
    const second = io.ask()
    await second.ready
    if (kind === 'ink') assert.equal(io.draftText(), '')
    io.submit('fresh after suspension')
    assert.equal(await second.promise, 'fresh after suspension')
  })

  test(`${kind}: clear discards the whole draft and settles empty exactly once`, async (t) => {
    const io = fixture(t, kind)
    const first = io.ask()
    await first.ready
    await io.draft('old suffix')
    if (kind === 'readline') await io.draft('\u001b[D\u001b[D')
    io.editor.clear()
    assert.equal(await first.promise, '')
    const second = io.ask()
    await second.ready
    if (kind === 'ink') assert.equal(io.draftText(), '')
    io.submit('new')
    assert.equal(await second.promise, 'new')
  })

  test(`${kind}: EOF releases ownership permanently instead of submitting an unfinished draft`, async (t) => {
    const io = fixture(t, kind)
    const first = io.ask()
    await first.ready
    await io.draft('unfinished at EOF')
    io.stdin.push(null)
    io.stdin.resume()
    assert.equal(await first.promise, null)
    assertReleased(io)
    io.editor.suspend()
    const next = io.ask()
    await nextTurn()
    assert.equal(next.observed.settled, true)
    assert.equal(await next.promise, null)
  })

  test(`${kind}: pre-aborted requests and repeated close never start a reader`, async (t) => {
    const controller = new AbortController()
    controller.abort()
    const io = fixture(t, kind, { signal: controller.signal })
    const first = io.ask()
    await nextTurn()
    assert.equal(first.observed.settled, true)
    assert.equal(await first.promise, null)
    assertReleased(io)
    io.editor.close()
    io.editor.close()
    assert.equal(await io.editor.question('closed> '), null)
  })
}

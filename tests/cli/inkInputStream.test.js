import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { createInkInputEditor } from '../../bin/cli/input/inkInputAdapter.js'
import { editorText } from '../../bin/cli/input/editorModel.js'

const supportsInk = Number(process.versions.node.split('.')[0]) >= 22

function deferred() {
  let resolve
  const promise = new Promise((value) => { resolve = value })
  return { promise, resolve }
}

/** Real Ink input parser/renderer with isolated streams, not a real terminal claim. */
async function createHarness() {
  const [{ createElement }, { render }, { InkInputEditor }] = await Promise.all([
    import('react'), import('ink'), import('../../bin/cli/input/inkEditor.js'),
  ])
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.isRaw = false
  let references = 0
  stdin.ref = () => { references += 1 }
  stdin.unref = () => { references -= 1 }
  stdin.setRawMode = (enabled) => { stdin.isRaw = enabled }
  const stdout = new PassThrough()
  stdout.isTTY = true
  stdout.columns = 28
  stdout.rows = 24
  const stderr = new PassThrough()
  let output = ''
  stdout.on('data', (data) => { output += data.toString() })
  let ready = deferred()
  let changed = deferred()
  let painted = deferred()
  let instance
  const editor = createInkInputEditor({
    stdin, stdout, stderr,
    loadRenderer: async () => (props, io) => {
      instance = render(createElement(InkInputEditor, {
        ...props, hint: '',
        onStateChange: (state) => { props.onStateChange(state); changed.resolve(state) },
      }), { ...io, interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 120,
        onRender: () => { ready.resolve(); painted.resolve() },
      })
      return instance
    },
  })
  return {
    editor, stdin, stdout,
    get output() { return output },
    get references() { return references },
    async begin() {
      ready = deferred()
      const answer = editor.question('问> ')
      await ready.promise
      await nextTurn()
      return { answer }
    },
    async input(text) {
      changed = deferred()
      stdin.write(text)
      const state = await changed.promise
      await instance.waitUntilRenderFlush()
      return state
    },
    async resize(width) {
      painted = deferred()
      stdout.columns = width
      stdout.emit('resize')
      await painted.promise
      await instance.waitUntilRenderFlush()
    },
  }
}

test('real Ink parser keeps Ctrl+J and bracketed paste multiline input unsubmitted', {
  skip: !supportsInk, timeout: 20000,
}, async (t) => {
  const state = await createHarness()
  t.after(() => state.editor.close())
  const { answer } = await state.begin()
  assert.equal(state.stdin.isRaw, true)
  await state.input('中文👩‍💻')
  assert.equal(editorText(await state.input('\n')), '中文👩‍💻\n')
  assert.equal(editorText(await state.input('\u001b[200~second\r\nthird\u001b[201~')), '中文👩‍💻\nsecond\nthird')
  assert.equal(state.stdin.isRaw, true, 'paste has not submitted or released the question')
  await state.resize(12)
  state.stdin.write('\r')
  assert.equal(await answer, '中文👩‍💻\nsecond\nthird')
  await nextTurn()
  assert.equal(state.stdin.isRaw, false)
  assert.equal(state.references, 0)
  assert.equal(state.stdout.listenerCount('resize'), 0)
  assert.equal(state.stdin.listenerCount('readable'), 0)
})

test('real Ink session can remount after submission and cancel without raw-mode listeners', {
  skip: !supportsInk, timeout: 20000,
}, async (t) => {
  const state = await createHarness()
  t.after(() => state.editor.close())
  const first = await state.begin()
  await state.input('a👍🏽')
  assert.equal(editorText(await state.input('\u007f')), 'a')
  state.stdin.write('\r')
  assert.equal(await first.answer, 'a')
  const second = await state.begin()
  await state.input('cancel me')
  state.stdin.write('\u0003')
  assert.equal(await second.answer, null)
  await nextTurn()
  assert.equal(state.references, 0)
  assert.equal(state.stdin.isRaw, false)
  assert.equal(state.stdin.listenerCount('readable'), 0)
  assert.equal(state.stdout.listenerCount('resize'), 0)
})

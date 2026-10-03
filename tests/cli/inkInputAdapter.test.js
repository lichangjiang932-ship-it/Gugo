import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'

import { assertInputEditor } from '../../bin/cli/cliContracts.js'
import { createEditorState } from '../../bin/cli/input/editorModel.js'
import { createInkInputEditor } from '../../bin/cli/input/inkInputAdapter.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue })
  return { promise, resolve, reject }
}

function harness(overrides = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdin.isTTY = true
  stdout.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (value) => { stdin.isRaw = value }
  const mounts = []
  let loads = 0
  let nextMount
  const mounted = () => new Promise((resolve) => { nextMount = resolve })
  const loadRenderer = async () => {
    loads += 1
    return (props) => {
      const exit = deferred()
      const instance = {
        props, cleanups: 0,
        cleanup() { this.cleanups += 1; stdin.isRaw = false; exit.resolve() },
        waitUntilExit: () => exit.promise,
        fail: exit.reject,
        exit: exit.resolve,
      }
      stdin.isRaw = true
      mounts.push(instance)
      nextMount?.(instance)
      return instance
    }
  }
  const editor = createInkInputEditor({ stdin, stdout, stderr, nodeVersion: '22.20.0', loadRenderer, ...overrides })
  return { editor, stdin, stdout, stderr, mounts, mounted, get loads() { return loads } }
}

test('adapter loads lazily and submits only once after releasing raw mode', async () => {
  const state = harness()
  assert.equal(assertInputEditor(state.editor), state.editor)
  assert.equal(state.loads, 0)
  const mounted = state.mounted()
  const answer = state.editor.question('> ')
  const renderer = await mounted
  renderer.props.onSubmit('hello')
  renderer.props.onSubmit('duplicate')
  renderer.props.onCancel('late')
  assert.equal(await answer, 'hello')
  assert.equal(renderer.cleanups, 1)
  assert.equal(state.stdin.isRaw, false)
  assert.equal(state.stdin.listenerCount('end'), 0)
  assert.equal(state.stdin.listenerCount('close'), 0)
  state.editor.close()
})

test('Node 20 and non-TTY streams fail before importing Ink or touching stdin', async () => {
  const oldNode = harness({ nodeVersion: '20.19.0' })
  await assert.rejects(oldNode.editor.question('> '), { code: 'CLI_INK_NODE_UNSUPPORTED' })
  assert.equal(oldNode.loads, 0)
  const piped = harness()
  piped.stdin.isTTY = false
  await assert.rejects(piped.editor.question('> '), { code: 'CLI_INK_TTY_REQUIRED' })
  assert.equal(piped.loads, 0)
})

test('an active input owner and concurrent questions are rejected', async () => {
  const state = harness()
  state.stdin.isRaw = true
  await assert.rejects(state.editor.question('> '), { code: 'CLI_INPUT_IN_USE' })
  state.stdin.isRaw = false
  const mounted = state.mounted()
  const answer = state.editor.question('> ')
  await mounted
  await assert.rejects(state.editor.question('again> '), { code: 'CLI_INPUT_BUSY' })
  state.editor.close()
  assert.equal(await answer, null)
})

test('two adapters cannot claim the same output with different input streams', async () => {
  const state = harness()
  const mounted = state.mounted()
  const answer = state.editor.question('> ')
  await mounted
  const conflicting = harness({ stdout: state.stdout })
  await assert.rejects(conflicting.editor.question('> '), { code: 'CLI_INPUT_IN_USE' })
  assert.equal(conflicting.loads, 0)
  state.editor.close()
  assert.equal(await answer, null)
})

test('input that has ended is never remounted', async () => {
  const state = harness()
  state.stdin.destroy()
  assert.equal(await state.editor.question('> '), null)
  assert.equal(state.loads, 0)
})

test('cancel, EOF and repeated close release input without keeping the process alive', async () => {
  for (const event of ['cancel', 'end', 'close']) {
    const state = harness()
    const mounted = state.mounted()
    const answer = state.editor.question('> ')
    const renderer = await mounted
    if (event === 'cancel') renderer.props.onCancel('draft')
    else state.stdin.emit(event)
    assert.equal(await answer, null)
    assert.equal(state.stdin.isRaw, false)
    state.editor.close()
    state.editor.close()
    assert.equal(await state.editor.question('later> '), null)
  }
})

test('clear settles the question with an empty draft; suspend discards the last draft', async () => {
  const state = harness()
  let mounted = state.mounted()
  const first = state.editor.question('one> ')
  const renderer = await mounted
  renderer.props.onStateChange(createEditorState({ text: '中👩‍💻' }))
  state.editor.suspend()
  assert.equal(await first, null)
  assert.equal(state.stdin.isRaw, false)
  mounted = state.mounted()
  const second = state.editor.question('two> ')
  const resumed = await mounted
  assert.equal(resumed.props.initialState.lines[0], '')
  state.editor.clear()
  assert.equal(await second, '')
  mounted = state.mounted()
  const third = state.editor.question('three> ')
  assert.equal((await mounted).props.initialState.lines[0], '')
  state.editor.close()
  assert.equal(await third, null)
})

test('abort while loading cannot create a late raw-mode input owner', async () => {
  const loaded = deferred()
  const started = deferred()
  const controller = new AbortController()
  let mounts = 0
  const state = harness({ signal: controller.signal, loadRenderer: () => { started.resolve(); return loaded.promise } })
  const answer = state.editor.question('> ')
  await started.promise
  controller.abort()
  assert.equal(await answer, null)
  loaded.resolve(() => { mounts += 1 })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(mounts, 0)
  assert.equal(state.stdin.isRaw, false)
})

test('abort, render failure and thrown mount restore input and reject with a stable code', async () => {
  const controller = new AbortController()
  const state = harness({ signal: controller.signal })
  const mounted = state.mounted()
  const answer = state.editor.question('> ')
  await mounted
  controller.abort()
  assert.equal(await answer, null)
  assert.equal(state.stdin.isRaw, false)

  const failure = harness()
  const failedMount = failure.mounted()
  const failedAnswer = failure.editor.question('> ')
  const rejected = assert.rejects(failedAnswer, { code: 'CLI_INK_RENDER_FAILED' })
  ;(await failedMount).fail(new Error('render failed'))
  await rejected
  assert.equal(failure.stdin.isRaw, false)

  let throwing
  throwing = harness({ loadRenderer: async () => () => {
    throwing.stdin.isRaw = true
    throw new Error('mount failed')
  } })
  await assert.rejects(throwing.editor.question('> '), { code: 'CLI_INK_RENDER_FAILED' })
  assert.equal(throwing.stdin.isRaw, false)
})

test('closing during dependency load does not reopen input', async () => {
  const loaded = deferred()
  const started = deferred()
  let mounts = 0
  const state = harness({ loadRenderer: () => { started.resolve(); return loaded.promise } })
  const answer = state.editor.question('> ')
  await started.promise
  state.editor.close()
  assert.equal(await answer, null)
  loaded.resolve(() => { mounts += 1 })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(mounts, 0)
})

test('an unexpected renderer exit rejects instead of looking like a keyboard cancellation', async () => {
  let cancelled = 0
  const state = harness({ onKeyboardCancel() { cancelled++ } })
  const mounted = state.mounted()
  const answer = state.editor.question('> ')
  const rejected = assert.rejects(answer, { code: 'CLI_INK_RENDER_FAILED' })
  ;(await mounted).exit()
  await rejected
  assert.equal(cancelled, 0)
  assert.equal(state.mounts.length, 1)
  assert.equal(state.stdin.isRaw, false)
  state.editor.close()
})

test('Ink stream EOF is permanent even before the stream object reflects its ended flag', async () => {
  const state = harness()
  const mounted = state.mounted()
  const pending = state.editor.question('> ')
  await mounted
  state.stdin.emit('end')
  assert.equal(await pending, null)
  assert.equal(await state.editor.question('after EOF> '), null)
  assert.equal(state.mounts.length, 1)
})

test('Ink drops unowned buffered input at handoff without consuming valid input during renderer loading', async () => {
  const state = harness()
  let mounted = state.mounted()
  const first = state.editor.question('> ')
  await mounted
  state.editor.suspend()
  assert.equal(await first, null)
  state.stdin.push('approval reply\n')
  mounted = state.mounted()
  const second = state.editor.question('next> ')
  state.stdin.push('valid current draft')
  const renderer = await mounted
  assert.equal(state.stdin.read().toString(), 'valid current draft')
  renderer.props.onSubmit('valid current draft')
  assert.equal(await second, 'valid current draft')
  state.editor.close()
})

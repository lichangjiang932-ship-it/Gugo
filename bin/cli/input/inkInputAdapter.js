import { CliError } from '../errors.js'
import { createEditorState } from './editorModel.js'

const inputOwners = new WeakMap()
const outputOwners = new WeakMap()

/** No Ink/React import happens on the default readline or unsupported Node 20 path. */
async function loadInkRenderer() {
  const [{ createElement }, { render }, { InkInputEditor }] = await Promise.all([
    import('react'), import('ink'), import('./inkEditor.js'),
  ])
  return (props, io) => render(createElement(InkInputEditor, props), {
    ...io, exitOnCtrlC: false, patchConsole: false, concurrent: false,
  })
}

function renderFailure() {
  return new CliError('CLI_INK_RENDER_FAILED', 'Ink input could not complete safely. Use the readline input editor; no draft was submitted.')
}

function assertSupported({ stdin, stdout, nodeVersion }) {
  if (Number.parseInt(nodeVersion, 10) < 22 || !Number.isFinite(Number.parseInt(nodeVersion, 10))) {
    throw new CliError('CLI_INK_NODE_UNSUPPORTED', 'The optional Ink 7 editor requires Node.js 22 or newer. The readline editor supports Node.js 20.')
  }
  if (stdin?.isTTY !== true || stdout?.isTTY !== true || typeof stdin.setRawMode !== 'function') {
    throw new CliError('CLI_INK_TTY_REQUIRED', 'Ink input requires interactive stdin and stdout. Use gugo run for piped input.')
  }
  if (stdin.isRaw === true || inputOwners.has(stdin) || outputOwners.has(stdout)) {
    throw new CliError('CLI_INPUT_IN_USE', 'Another input reader already owns this terminal. Suspend it before starting Ink.')
  }
}

function watchQuestion(record, { stdin }, signal, finish, onEof) {
  const onAbort = () => finish(null)
  const onError = () => finish(null, renderFailure())
  stdin.once('end', onEof)
  stdin.once('close', onEof)
  stdin.once('error', onError)
  signal?.addEventListener('abort', onAbort, { once: true })
  record.removeListeners = () => {
    stdin.removeListener('end', onEof)
    stdin.removeListener('close', onEof)
    stdin.removeListener('error', onError)
    signal?.removeEventListener('abort', onAbort)
  }
}

class InkEditorAdapter {
  constructor(options) {
    this.options = options
    this.pending = null
    this.closed = false
    this.draft = createEditorState()
    this.renderer = null
    this.drainBeforeQuestion = false
    this.onSessionAbort = () => this.close()
    options.signal?.addEventListener('abort', this.onSessionAbort, { once: true })
    if (options.signal?.aborted) this.close()
  }

  question(promptText, { signal } = {}) {
    if (this.closed || this.options.stdin?.readableEnded || this.options.stdin?.destroyed
      || this.options.signal?.aborted) { this.close(); return Promise.resolve(null) }
    if (this.pending) return Promise.reject(new CliError('CLI_INPUT_BUSY', 'An input question is already pending.'))
    if (signal?.aborted) return Promise.resolve(null)
    try { assertSupported(this.options) } catch (error) { return Promise.reject(error) }
    // Bytes buffered during an ownership handoff may be approval answers or a
    // cancelled draft. Do this before claiming the next question, never at mount.
    if (this.drainBeforeQuestion && typeof this.options.stdin.read === 'function') {
      while (this.options.stdin.read() !== null) { /* Unowned terminal input only. */ }
    }
    return new Promise((resolve, reject) => {
      const record = { resolve, reject, promptText, settled: false, mounting: false, outcome: null, instance: null }
      this.pending = record
      inputOwners.set(this.options.stdin, record)
      outputOwners.set(this.options.stdout, record)
      watchQuestion(record, this.options, signal, (value, error) => this.finish(record, value, error), () => this.close())
      if (signal?.aborted || this.closed) { this.finish(record, null); return }
      void this.mount(record)
    })
  }

  async mount(record) {
    try {
      this.renderer ??= Promise.resolve().then(() => this.options.loadRenderer())
      const mount = await this.renderer
      if (record.settled || this.pending !== record) return
      record.mounting = true
      record.instance = mount({
        prompt: String(record.promptText ?? ''),
        initialState: this.draft,
        hint: this.options.hint,
        onStateChange: (state) => { if (!record.settled) this.draft = state },
        onSubmit: (text) => this.finish(record, String(text)),
        onCancel: () => this.finish(record, null, undefined, true),
      }, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr })
      record.mounting = false
      if (record.outcome) {
        this.finish(record, record.outcome.value, record.outcome.error, record.outcome.keyboardCancel)
        return
      }
      Promise.resolve(record.instance.waitUntilExit()).then(
        () => this.finish(record, null, renderFailure()),
        () => this.finish(record, null, renderFailure()),
      )
    } catch {
      record.mounting = false
      this.finish(record, null, renderFailure())
    }
  }

  finish(record, value, error, keyboardCancel = false) {
    if (record.settled) return
    record.outcome ??= { value, error, keyboardCancel }
    if (record.mounting) return
    record.settled = true
    record.removeListeners?.()
    if (this.pending === record) this.pending = null
    this.draft = createEditorState()
    this.drainBeforeQuestion = true
    let failure = error
    try {
      if (record.instance?.cleanup) record.instance.cleanup()
      else record.instance?.unmount?.()
    } catch { failure = renderFailure() }
    try {
      if (inputOwners.get(this.options.stdin) === record) {
        if (this.options.stdin.isRaw === true) this.options.stdin.setRawMode(false)
        this.options.stdin.pause()
      }
    } catch { failure = renderFailure() }
    if (inputOwners.get(this.options.stdin) === record) inputOwners.delete(this.options.stdin)
    if (outputOwners.get(this.options.stdout) === record) outputOwners.delete(this.options.stdout)
    if (!failure && record.outcome.keyboardCancel) {
      try { this.options.onKeyboardCancel?.() } catch { failure = renderFailure() }
    }
    // Only terminal teardown can follow submission. Never remount/replay on a render error.
    if (failure) record.reject(failure)
    else record.resolve(record.outcome.value)
  }

  clear() {
    this.draft = createEditorState()
    if (this.pending) this.finish(this.pending, '')
  }

  suspend() {
    this.draft = createEditorState()
    if (this.pending) this.finish(this.pending, null)
  }

  close() {
    this.closed = true
    this.options.signal?.removeEventListener('abort', this.onSessionAbort)
    this.draft = createEditorState()
    if (this.pending) this.finish(this.pending, null)
  }
}

/** Optional InputEditor. Abort/EOF/suspend => null; clear => ''; unfinished drafts are discarded. */
export function createInkInputEditor({
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  signal, hint, onKeyboardCancel, nodeVersion = process.versions.node, loadRenderer = loadInkRenderer,
} = {}) {
  return new InkEditorAdapter({ stdin, stdout, stderr, signal, hint, onKeyboardCancel, nodeVersion, loadRenderer })
}

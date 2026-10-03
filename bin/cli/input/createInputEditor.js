import { CliError, CliUsageError } from '../errors.js'
import { createReadlineInputEditor } from './readlineInputAdapter.js'
import { createInkInputEditor } from './inkInputAdapter.js'
import { assertInputEditor } from '../cliContracts.js'

/** Canonical modes are readline|ink. Legacy auto always aliases readline, never TTY detection. */
export function createInteractiveInputEditor(options, {
  env = {}, nodeVersion = process.versions.node,
  readlineFactory = createReadlineInputEditor, inkFactory = createInkInputEditor,
} = {}) {
  const requested = String(env.GUGO_CLI_INPUT || 'readline').trim().toLowerCase() || 'readline'
  const mode = requested === 'auto' ? 'readline' : requested
  if (!['readline', 'ink'].includes(mode)) {
    throw new CliUsageError('CLI_INPUT_MODE_INVALID', 'GUGO_CLI_INPUT must be readline or ink; legacy auto is an alias for readline')
  }
  if (mode !== 'ink') return assertInputEditor(readlineFactory(options))
  if (!Number.isFinite(Number.parseInt(nodeVersion, 10)) || Number.parseInt(nodeVersion, 10) < 22) {
    throw new CliUsageError('CLI_INK_NODE_UNSUPPORTED', 'The optional Ink editor requires Node.js 22; use readline on Node.js 20')
  }
  let keyboardCancellations = 0
  const editor = assertInputEditor(inkFactory({ ...options, nodeVersion, onKeyboardCancel: () => { keyboardCancellations++ } }))
  let closed = false
  let generation = 0
  let pending = null
  return {
    async question(prompt, request = {}) {
      if (closed || options.signal?.aborted || options.stdin?.readableEnded || options.stdin?.destroyed) return null
      if (pending) throw new CliError('CLI_INPUT_BUSY', 'An input question is already pending.')
      if (request.signal?.aborted) return null
      const current = generation
      const record = { interrupted: null }
      pending = record
      try {
        while (!closed) {
          const before = keyboardCancellations
          const value = await editor.question(prompt, request)
          if (record.interrupted) return record.interrupted.value
          if (value !== null || current !== generation || options.signal?.aborted || request.signal?.aborted
            || options.stdin?.readableEnded || options.stdin?.destroyed || before === keyboardCancellations) return value
          // Only the renderer's explicit keyboard cancel participates in the
          // first-warning/second-exit policy. EOF/abort/suspend never remount.
          if (typeof options.onSigint !== 'function') return null
          options.onSigint()
          if (record.interrupted) return record.interrupted.value
        }
        return null
      } finally { if (pending === record) pending = null }
    },
    clear() { if (pending) pending.interrupted ||= { value: '' }; generation++; editor.clear() },
    suspend() { if (pending) pending.interrupted ||= { value: null }; generation++; editor.suspend() },
    close() { closed = true; if (pending) pending.interrupted ||= { value: null }; generation++; editor.close() },
  }
}

import { createInterface } from 'node:readline'
import { appendInteractiveHistory, readInteractiveHistory, writeInteractiveHistory } from '../interactiveHistory.js'
import { CliError } from '../errors.js'

/**
 * Line reader that owns stdin between turns and yields it during a turn.
 *
 * Two failure modes are handled explicitly, both reproduced while writing the
 * tests:
 *   - Creating a readline per question breaks the *second* question: once the
 *     first interface closes, the next one never sees buffered input.
 *   - A line that arrives while no question is pending is dropped by readline,
 *     so a fast paste or a queued script line is lost.
 * So there is one long-lived interface plus a line queue, and `suspend()`
 * releases stdin (generation-guarded, so the closed interface cannot clobber
 * the new one) while a turn needs it for approval and recovery prompts.
 */
class ReadlineEditorAdapter {
  constructor({ stdin = process.stdin, stdout = process.stdout, onSigint, completeLine, historyFile, signal } = {}) {
    this.options = { stdin, stdout, onSigint, completeLine, historyFile, signal }
    this.queue = []
    this.rl = null
    this.pending = null
    this.closed = false
    this.ended = false
    this.generation = 0
    this.drainBeforeAttach = false
    // Keep filtered persisted history separate from readline's editing history.
    this.persisted = readInteractiveHistory(historyFile)
    this.history = [...this.persisted].reverse().slice(0, 100)
    this.onSessionAbort = () => this.close()
    if (signal?.aborted || stdin.readableEnded || stdin.destroyed) { this.closed = true; return }
    signal?.addEventListener('abort', this.onSessionAbort, { once: true })
    try { this.attach() } catch (error) { this.close(); throw error }
    if (signal?.aborted) this.close()
  }

  attach() {
    if (this.closed || this.ended || this.rl) return
    const { stdin, stdout, onSigint, completeLine, historyFile } = this.options
    if (stdin.readableEnded || stdin.destroyed) { this.endInput(); return }
    // Complete submitted lines live in queue. Raw bytes received while the
    // reader yielded stdin may belong to approval/recovery, never the next task.
    if (this.drainBeforeAttach && typeof stdin.read === 'function') {
      while (stdin.read() !== null) { /* Discard only at the ownership handoff. */ }
    }
    const mine = ++this.generation
    const onEof = () => this.endInput()
    stdin.once('end', onEof)
    stdin.once('close', onEof)
    this.removeEofListeners = () => {
      stdin.removeListener('end', onEof)
      stdin.removeListener('close', onEof)
    }
    const iface = createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
      history: [...this.history],
      historySize: 100,
      completer: completeLine,
    })
    this.rl = iface
    iface.on('SIGINT', () => { if (mine === this.generation) onSigint?.() })
    iface.on('line', (line) => {
      if (this.closed || mine !== this.generation) return
      this.history = [...iface.history]
      this.persisted = appendInteractiveHistory(this.persisted, line)
      writeInteractiveHistory(historyFile, this.persisted)
      if (this.pending) this.settle(line)
      else this.queue.push(line)
    })
    iface.on('close', () => {
      if (mine === this.generation) this.endInput()
    })
  }

  settle(value, error) {
    const record = this.pending
    if (!record) return
    this.pending = null
    record.removeAbort?.()
    if (error !== undefined) record.reject(error)
    else record.resolve(value)
  }

  release() {
    const iface = this.rl
    this.rl = null
    this.generation++
    this.drainBeforeAttach = true
    this.removeEofListeners?.()
    this.removeEofListeners = null
    if (iface) {
      this.history = [...iface.history]
      iface.close()
    }
  }

  async question(promptText, { signal } = {}) {
    if (this.closed || this.options.signal?.aborted) {
      this.close()
      return null
    }
    if (this.pending) throw new CliError('CLI_INPUT_BUSY', 'An input question is already pending.')
    if (signal?.aborted) { this.release(); return null }
    if (this.queue.length > 0) return this.queue.shift()
    if (this.ended || this.options.stdin.readableEnded || this.options.stdin.destroyed) {
      this.endInput()
      return null
    }
    return await new Promise((resolve, reject) => {
      const record = { resolve, reject }
      const abort = () => {
        if (this.pending !== record) return
        this.release()
        this.settle(null)
      }
      record.removeAbort = () => signal?.removeEventListener('abort', abort)
      this.pending = record
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try {
        this.attach()
        if (this.pending !== record) return
        this.rl.setPrompt(promptText)
        this.rl.prompt()
      } catch (error) { this.release(); this.settle(null, error) }
    })
  }

  clear() {
    this.queue.length = 0
    this.release()
    this.settle('')
  }

  suspend() {
    this.release()
    this.settle(null)
  }

  endInput() {
    this.ended = true
    this.options.signal?.removeEventListener('abort', this.onSessionAbort)
    this.release()
    // EOF never submits an unfinished line or reopens stdin. Already-submitted
    // complete lines remain consumable, unlike explicit close/global abort.
    this.settle(null)
  }

  close() {
    this.closed = true
    this.queue.length = 0
    this.options.signal?.removeEventListener('abort', this.onSessionAbort)
    this.release()
    this.settle(null)
  }
}

export function createReadlineInputEditor(options) {
  return new ReadlineEditorAdapter(options)
}

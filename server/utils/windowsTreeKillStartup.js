import { performance } from 'node:perf_hooks'

const PREFIX = 'GUGO_WORKER_STARTUP\t'
const MAX_LINE_CHARS = 128
const PHASES = [
  'spawn_requested', 'bootstrap_entered', 'payload_received', 'payload_decoded',
  'worker_entered', 'utility_import_begin', 'utility_import_end',
  'add_type_begin', 'add_type_end', 'ready',
]

export function windowsWorkerStartupMarker(phase) {
  if (!PHASES.includes(phase)) throw new Error('Unknown Windows worker startup phase')
  return `[Console]::Error.WriteLine('GUGO_WORKER_STARTUP' + [char]9 + '${phase}'); [Console]::Error.Flush()`
}

// stderr may contain paths, source text or host errors. Retain only this fixed
// vocabulary, never raw output; even an unterminated noisy line stays bounded.
export function createWindowsWorkerStartupDiagnostics({ now = () => performance.now() } = {}) {
  const startedAt = now()
  const phases = [{ phase: PHASES[0], elapsedMs: 0 }]
  let highestPhase = 0
  let line = ''
  let discardingLine = false
  const elapsed = () => Math.max(0, Math.round(now() - startedAt))
  const record = (phase) => {
    const index = PHASES.indexOf(phase)
    if (index <= highestPhase) return
    highestPhase = index
    phases.push({ phase, elapsedMs: elapsed() })
  }
  return {
    accept(chunk) {
      for (const character of String(chunk || '')) {
        if (character === '\n') {
          if (!discardingLine && line.startsWith(PREFIX)) {
            const phase = line.slice(PREFIX.length).replace(/\r$/u, '')
            if (phase !== 'ready') record(phase)
          }
          line = ''
          discardingLine = false
        } else if (!discardingLine) {
          if (line.length < MAX_LINE_CHARS) line += character
          else { line = ''; discardingLine = true }
        }
      }
    },
    ready() { record('ready') },
    snapshot() {
      return { phase: PHASES[highestPhase], elapsedMs: elapsed(), phases: phases.map((item) => ({ ...item })) }
    },
    annotate(error) {
      if (error.startupDiagnostics) return error
      const diagnostic = this.snapshot()
      error.startupDiagnostics = diagnostic
      error.message += ` [startup phase=${diagnostic.phase}, elapsedMs=${diagnostic.elapsedMs}]`
      return error
    },
  }
}

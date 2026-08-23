let boundTurnLoopRunner = null
let boundTurnToolSpecs = Object.freeze([])

export function configureTurnLoopRunner(runLoop) {
  if (typeof runLoop !== 'function') throw new TypeError('turn loop runner must be a function')
  boundTurnLoopRunner = runLoop
}

export function runBoundTurnLoop(options = {}) {
  if (!boundTurnLoopRunner) {
    const error = new Error('TurnEngine requires its host to provide a Tool Loop runtime')
    error.code = 'TURN_LOOP_RUNTIME_NOT_CONFIGURED'
    error.statusCode = 503
    error.retryable = false
    throw error
  }
  return boundTurnLoopRunner(options)
}

export function configureTurnToolSpecs(toolSpecs) {
  if (!Array.isArray(toolSpecs)) throw new TypeError('turn tool specs must be an array')
  boundTurnToolSpecs = toolSpecs
}

export function getBoundTurnToolSpecs() {
  return boundTurnToolSpecs
}

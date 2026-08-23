const READINESS_STATES = new Set(['starting', 'ready', 'failed'])

const RUNTIME_LIVENESS_PATH = '/api/health'

function rawRequestPath(req) {
  const target = String(req?.url || '/')
  // Origin-form request targets must be retained verbatim here. WHATWG URL
  // parsing removes encoded dot segments, while capability matchers consume
  // the original req.url. Readiness must therefore classify both views or an
  // encoded /api/* target can normalize into a static path and bypass the gate.
  if (target.startsWith('/')) return target.split(/[?#]/, 1)[0]
  try {
    return new URL(target, 'http://localhost').pathname
  } catch {
    return target.split(/[?#]/, 1)[0]
  }
}

function normalizeInitialState(value) {
  const state = String(value || '').trim().toLowerCase()
  if (!READINESS_STATES.has(state)) {
    throw new TypeError('runtime readiness initialState must be starting, ready, or failed')
  }
  return state
}

function normalizedRequestPath(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://localhost').pathname
  } catch {
    return rawRequestPath(req)
  }
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

export function requiresRuntimeReadiness(req) {
  if (isRuntimeLivenessRequest(req)) return false
  const rawPathname = rawRequestPath(req)
  const normalizedPathname = normalizedRequestPath(req)
  return rawPathname === '/mcp'
    || normalizedPathname === '/mcp'
    || isApiPath(rawPathname)
    || isApiPath(normalizedPathname)
}

export function isRuntimeLivenessRequest(req) {
  // Only the canonical liveness target is exempt. A different raw /api/*
  // target that merely normalizes to /api/health remains fail-closed.
  return rawRequestPath(req) === RUNTIME_LIVENESS_PATH
    && normalizedRequestPath(req) === RUNTIME_LIVENESS_PATH
}

export function runtimeNotReadyMessage(state) {
  return state === 'failed'
    ? 'Runtime startup did not complete. Check local diagnostics and retry.'
    : 'Runtime is starting. Try again shortly.'
}

export function createRuntimeReadinessController({
  initialState = 'starting',
  now = () => Date.now(),
} = {}) {
  if (typeof now !== 'function') throw new TypeError('runtime readiness now must be a function')
  let state = normalizeInitialState(initialState)
  let updatedAt = now()

  const transitionFromStarting = (nextState) => {
    if (state !== 'starting') return false
    state = nextState
    updatedAt = now()
    return true
  }

  return Object.freeze({
    isReady: () => state === 'ready',
    getState: () => state,
    snapshot: () => Object.freeze({
      state,
      ready: state === 'ready',
      updatedAt,
    }),
    markReady: () => transitionFromStarting('ready'),
    markFailed: () => transitionFromStarting('failed'),
  })
}

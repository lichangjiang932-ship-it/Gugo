function assertRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Loop model request must be an object')
  }
  return value
}

const MODEL_EVENT_CONTEXT_FIELDS = Object.freeze([
  'userId',
  'sessionId',
  'jobId',
  'stepId',
  'iteration',
  'phase',
  'executed',
])

function modelEventContext(context, attempt) {
  const source = context && typeof context === 'object' ? context : {}
  const metadata = {}
  for (const field of MODEL_EVENT_CONTEXT_FIELDS) {
    const value = source[field]
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      metadata[field] = value
    }
  }
  metadata.attempt = attempt
  return Object.freeze(metadata)
}

async function prepareRequest(loopEvents, request, context, attempt) {
  const initial = assertRequest(request)
  if (!loopEvents || typeof loopEvents.waterfall !== 'function') return initial
  const prepared = await loopEvents.waterfall('request', initial, modelEventContext(context, attempt))
  return assertRequest(prepared)
}

async function prepareInvocation({ request, attempt, loopEvents, context, beforeRequest }) {
  const prepared = await prepareRequest(loopEvents, request, context, attempt)
  if (typeof beforeRequest === 'function') {
    await beforeRequest({ request: prepared, attempt, kind: 'model' })
  }
  return prepared
}

/**
 * Execute one physical model request. The request event is a waterfall, and a
 * request-error listener may claim exactly one retry with { kind: 'retry' }.
 */
export async function runModelStep({
  request,
  runModel,
  beforeRequest = null,
  loopEvents = null,
  context = {},
} = {}) {
  if (typeof runModel !== 'function') throw new TypeError('runModel must be a function')

  let attemptedRequest = request
  let preparedRequest
  try {
    preparedRequest = await prepareInvocation({
      request: attemptedRequest,
      attempt: 1,
      loopEvents,
      context,
      beforeRequest,
    })
    return await runModel(preparedRequest)
  } catch (error) {
    if (!loopEvents || typeof loopEvents.waterfall !== 'function') throw error
    const failedRequest = preparedRequest ?? attemptedRequest
    const decision = await loopEvents.waterfall('request-error', {
      kind: 'error',
      error,
      request: failedRequest,
      attempt: 1,
    }, modelEventContext(context, 1))
    if (decision?.kind !== 'retry') throw error
    attemptedRequest = decision.request ?? failedRequest
  }

  const retriedRequest = await prepareInvocation({
    request: attemptedRequest,
    attempt: 2,
    loopEvents,
    context,
    beforeRequest,
  })
  return runModel(retriedRequest)
}

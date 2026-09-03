import { getEvolutionOperationForResult } from '../services/evolutionOperationService.js'

export function errorBody(code, message, operationId = null) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(operationId ? { operationId } : {}),
    },
  }
}

export function requestIdempotencyKey(req, body) {
  const rawHeader = req.headers?.['idempotency-key']
  const header = String(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader || '').trim()
  const bodyKey = String(body?.idempotencyKey || '').trim()
  if (header && bodyKey && header !== bodyKey) {
    throw Object.assign(new Error('Idempotency-Key header and body idempotencyKey must match'), {
      code: 'EVOLUTION_IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    })
  }
  return header || bodyKey || undefined
}

export function operationForResult(res, { userId, resultType, resultId }) {
  const operation = getEvolutionOperationForResult({ userId, resultType, resultId })
  if (operation) res.setHeader('X-Evolution-Operation-Id', operation.id)
  return operation
}

import crypto from 'node:crypto'

import {
  canonicalSideEffectArgsDigest,
  getSideEffectExecutionLedger,
  sideEffectRecoveryBlock,
} from './sideEffectExecutionLedger.js'

export const HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN = 'HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN'
export const HOOK_SIDE_EFFECT_LEDGER_CONFLICT = 'HOOK_SIDE_EFFECT_LEDGER_CONFLICT'

const MAX_INVOCATION_ID_LENGTH = 500

function requiredText(value, name, maxLength = MAX_INVOCATION_ID_LENGTH) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new TypeError(`${name} is required`)
  if (normalized.length > maxLength) throw new TypeError(`${name} is too long`)
  return normalized
}

function stableDigest(value) {
  return canonicalSideEffectArgsDigest(value)
}

function payloadIdentity(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const stable = { ...payload }
  delete stable.timestamp
  delete stable.idempotencyKey
  return stable
}

function hookConfigIdentity(hook) {
  return {
    id: hook.id,
    userId: hook.userId,
    event: hook.event,
    toolPattern: hook.toolPattern,
    argumentMatcher: hook.argumentMatcher,
    kind: hook.kind,
    command: hook.command,
    url: hook.url,
    headers: hook.headers,
    blocking: hook.blocking,
    timeoutMs: hook.timeoutMs,
    updatedAt: hook.updatedAt,
  }
}

export function createHookSideEffectIdentity({ hook, payload, invocationId } = {}) {
  const ownerId = requiredText(hook?.userId, 'hook.userId')
  const hookId = requiredText(hook?.id, 'hook.id')
  const requestId = requiredText(invocationId, 'hook invocationId')
  const event = requiredText(hook?.event, 'hook.event', 200)
  const invocationDigest = crypto.createHash('sha256')
    .update(JSON.stringify([ownerId, requestId, event, hookId]))
    .digest('hex')
  const idempotencyKey = `hook_${invocationDigest}`
  return {
    scope: {
      ownerId,
      kind: 'request',
      scopeKey: JSON.stringify(['request', requestId, event]),
      requestId,
      sessionId: payload?.sessionId || null,
      turnId: null,
      jobId: payload?.jobId || null,
      stepId: payload?.stepId || null,
    },
    effectKind: 'hook',
    toolCallId: `hook:${invocationDigest}`,
    idempotencyKey,
    toolName: `hook:${event}:${hook.kind}`,
    args: {
      hookId,
      hookConfigDigest: stableDigest(hookConfigIdentity(hook)),
      payloadDigest: stableDigest(payloadIdentity(payload)),
    },
  }
}

function hookExecutionBlock(code, message, record = null) {
  const error = sideEffectRecoveryBlock(code, message, record)
  error.name = 'HookSideEffectRecoveryError'
  return error
}

function replayOrBlock(ledger, input, record) {
  if (record.status === 'committed' || record.status === 'failed') {
    return { replayed: true, outcome: ledger.parseOutcome(record), record }
  }
  if (record.status === 'unknown') {
    throw hookExecutionBlock(
      HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN,
      'The Hook outcome requires manual verification and was not replayed.',
      record,
    )
  }
  if (record.status === 'executing') {
    let unknown = record
    try { unknown = ledger.markUnknown(input) || record } catch { /* fail closed below */ }
    throw hookExecutionBlock(
      HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN,
      'The Hook execution boundary was already crossed. Its outcome is unknown and it was not replayed.',
      unknown,
    )
  }
  if (record.status !== 'prepared') {
    throw hookExecutionBlock(
      HOOK_SIDE_EFFECT_LEDGER_CONFLICT,
      'The Hook durable record has an invalid state and execution was blocked.',
      record,
    )
  }
  return null
}

export function createHookSideEffectExecutor({
  ledger = getSideEffectExecutionLedger(),
} = {}) {
  const inFlight = new Map()

  const runOnce = async ({ hook, payload, invocationId, execute }) => {
    if (typeof execute !== 'function') throw new TypeError('execute is required')
    const input = createHookSideEffectIdentity({ hook, payload, invocationId })
    const prepared = ledger.prepare(input)
    const replay = replayOrBlock(ledger, input, prepared)
    if (replay) return replay

    const claim = ledger.claimExecution(input)
    if (claim?.claimed !== true || claim.record?.status !== 'executing') {
      const latest = claim?.record || ledger.read(input)
      const claimedReplay = latest ? replayOrBlock(ledger, input, latest) : null
      if (claimedReplay) return claimedReplay
      throw hookExecutionBlock(
        HOOK_SIDE_EFFECT_LEDGER_CONFLICT,
        'The Hook execution boundary could not be claimed safely.',
        latest,
      )
    }

    let outcome
    try {
      outcome = await execute({ idempotencyKey: input.idempotencyKey })
    } catch (error) {
      let unknown = claim.record
      try { unknown = ledger.markUnknown(input) || claim.record } catch { /* fail closed below */ }
      throw hookExecutionBlock(
        HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN,
        `The Hook failed after crossing its side-effect boundary: ${error?.message || String(error)}`,
        unknown,
      )
    }

    try {
      const record = ledger.finish(input, {
        status: outcome?.error ? 'failed' : 'committed',
        outcome,
      })
      return { replayed: false, outcome, record }
    } catch (error) {
      let unknown = null
      try { unknown = ledger.markUnknown(input, { outcome }) } catch { /* fail closed below */ }
      throw hookExecutionBlock(
        HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN,
        `The Hook returned, but its durable outcome could not be committed: ${error?.message || String(error)}`,
        unknown,
      )
    }
  }

  const execute = (input) => {
    const identity = createHookSideEffectIdentity(input)
    const key = `${identity.scope.ownerId}\u0000${identity.scope.scopeKey}\u0000${identity.toolCallId}`
    const existing = inFlight.get(key)
    if (existing) return existing
    const pending = runOnce(input).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
    return pending
  }

  return Object.freeze({ execute })
}

let singleton = null
let singletonLedger = null

export function getHookSideEffectExecutor() {
  const ledger = getSideEffectExecutionLedger()
  if (!singleton || singletonLedger !== ledger) {
    singletonLedger = ledger
    singleton = createHookSideEffectExecutor({ ledger })
  }
  return singleton
}

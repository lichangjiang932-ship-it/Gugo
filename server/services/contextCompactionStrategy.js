export const CONTEXT_COMPACTION_STRATEGY_SERVICE = 'context-compaction-strategy'
export const CONTEXT_COMPACTION_STRATEGY_TIMEOUT_MS = 5_000

const STRATEGY_ACTIONS = new Set(['default', 'compact'])
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const NO_PLUGIN_SERVICE = async () => ({ found: false, pluginId: null, value: undefined })
let invokeRuntimePluginService = NO_PLUGIN_SERVICE

export function configureContextCompactionStrategyServiceInvoker(invokeService) {
  if (typeof invokeService !== 'function') {
    throw new TypeError('context compaction strategy service invoker must be a function')
  }
  invokeRuntimePluginService = invokeService
}

function boundedInteger(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) return fallback
  return number
}

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return undefined
  }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function stableErrorCode(error, fallback) {
  const code = ownDataValue(error, 'code')
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : fallback
}

function strategyScope(input) {
  const roleCounts = input?.roleCounts && typeof input.roleCounts === 'object'
    ? input.roleCounts
    : {}
  return Object.freeze({
    contextWindow: boundedInteger(input?.contextWindow),
    activeContextTokens: boundedInteger(input?.activeContextTokens),
    threshold: boundedInteger(input?.threshold),
    estimatedTokens: boundedInteger(input?.estimatedTokens),
    messageEstimatedTokens: boundedInteger(input?.messageEstimatedTokens),
    messageCount: boundedInteger(input?.messageCount),
    roleCounts: Object.freeze({
      system: boundedInteger(roleCounts.system),
      user: boundedInteger(roleCounts.user),
      assistant: boundedInteger(roleCounts.assistant),
      tool: boundedInteger(roleCounts.tool),
      other: boundedInteger(roleCounts.other),
    }),
    toolCount: boundedInteger(input?.toolCount),
    overMessageLimit: input?.overMessageLimit === true,
    force: input?.force === true,
    hostCompactionRequired: input?.hostCompactionRequired === true,
    defaultKeepMessages: Math.max(1, boundedInteger(input?.defaultKeepMessages, 1)),
    maxKeepMessages: Math.max(1, boundedInteger(input?.maxKeepMessages, 1)),
    rollingToolResultsCompacted: boundedInteger(input?.rollingToolResultsCompacted),
  })
}

function provenance({ pluginId = null, decision, error = null }) {
  return Object.freeze({
    pluginId: typeof pluginId === 'string' && pluginId.trim() ? pluginId.trim().slice(0, 80) : null,
    service: CONTEXT_COMPACTION_STRATEGY_SERVICE,
    mode: 'advisory_only',
    decision,
    ...(error ? { error } : {}),
  })
}

function builtinDecision(scope, details = {}) {
  return Object.freeze({
    shouldCompact: scope.hostCompactionRequired,
    keepMessages: scope.defaultKeepMessages,
    provenance: provenance({ decision: 'builtin', ...details }),
  })
}

function normalizeStrategyResult(value, scope) {
  const action = ownDataValue(value, 'action')
  if (typeof action !== 'string' || !STRATEGY_ACTIONS.has(action)) return null
  const keepMessages = ownDataValue(value, 'keepMessages')
  if (action === 'default' && keepMessages !== undefined) return null
  if (keepMessages !== undefined
    && (!Number.isSafeInteger(keepMessages)
      || keepMessages < 1
      || keepMessages > scope.maxKeepMessages)) return null
  return Object.freeze({
    action,
    keepMessages: keepMessages === undefined ? scope.defaultKeepMessages : keepMessages,
  })
}

async function invokeWithTimeout(callback, timeoutMs) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('runtime context compaction strategy timed out')
          error.code = 'PLUGIN_CONTEXT_COMPACTION_STRATEGY_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Resolve an optional runtime compaction strategy without exposing messages,
 * model callbacks, persistence handles, or user/session identifiers.
 * Plugins may request earlier compaction or a smaller retained tail, but they
 * cannot cancel a compaction required by the host safety boundary.
 */
export async function resolveRuntimeContextCompactionStrategy(input = {}, dependencies = {}) {
  const scope = strategyScope(input)
  const invokeService = dependencies.invokePluginService || invokeRuntimePluginService
  const configuredTimeout = Number(dependencies.timeoutMs)
  const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 60_000)
    : CONTEXT_COMPACTION_STRATEGY_TIMEOUT_MS

  let invoked
  try {
    invoked = await invokeWithTimeout(
      () => invokeService(CONTEXT_COMPACTION_STRATEGY_SERVICE, 'select', [scope]),
      timeoutMs,
    )
  } catch (error) {
    return builtinDecision(scope, {
      pluginId: ownDataValue(error, 'pluginId'),
      error: stableErrorCode(error, 'PLUGIN_CONTEXT_COMPACTION_STRATEGY_FAILED'),
    })
  }
  if (!invoked?.found) return builtinDecision(scope)

  const selected = normalizeStrategyResult(invoked.value, scope)
  if (!selected) {
    return builtinDecision(scope, {
      pluginId: invoked.pluginId,
      error: 'PLUGIN_CONTEXT_COMPACTION_STRATEGY_RESULT_INVALID',
    })
  }
  const shouldCompact = scope.hostCompactionRequired || selected.action === 'compact'
  return Object.freeze({
    shouldCompact,
    keepMessages: selected.keepMessages,
    provenance: provenance({
      pluginId: invoked.pluginId,
      decision: selected.action === 'compact' ? 'compact' : 'default',
    }),
  })
}

export const TOOL_RISK_CLASSES = Object.freeze({ READ: 'read', WRITE_LOCAL: 'write_local', EXEC: 'exec', EXTERNAL: 'external' })

const VALID = new Set(Object.values(TOOL_RISK_CLASSES))
const INTERRUPT_BEHAVIORS = new Set(['cancel', 'block'])

function defaultGetPath(args = {}) {
  if (!args || typeof args !== 'object') return null
  for (const key of ['path', 'cwd', 'repository', 'repo', 'url', 'target']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim()
  }
  return null
}

export function normalizeToolRiskMetadata(metadata, { origin = 'dynamic' } = {}) {
  const value = metadata && typeof metadata === 'object' ? metadata : {}
  const riskClass = VALID.has(value.riskClass) ? value.riskClass : TOOL_RISK_CLASSES.EXTERNAL
  const isReadOnly = value.isReadOnly == null
    ? (value.readOnly == null ? riskClass === TOOL_RISK_CLASSES.READ : value.readOnly === true)
    : value.isReadOnly === true
  const isConcurrencySafe = value.isConcurrencySafe == null ? isReadOnly : value.isConcurrencySafe === true
  const interruptBehavior = INTERRUPT_BEHAVIORS.has(value.interruptBehavior)
    ? value.interruptBehavior
    : (isReadOnly ? 'cancel' : 'block')
  const isDestructive = value.isDestructive == null
    ? [TOOL_RISK_CLASSES.EXEC, TOOL_RISK_CLASSES.EXTERNAL].includes(riskClass)
    : value.isDestructive === true
  return Object.freeze({
    riskClass,
    requiresApproval: value.requiresApproval == null ? riskClass !== TOOL_RISK_CLASSES.READ : value.requiresApproval === true,
    isReadOnly,
    readOnly: isReadOnly,
    isConcurrencySafe,
    interruptBehavior,
    isDestructive,
    getPath: typeof value.getPath === 'function' ? value.getPath : defaultGetPath,
    origin,
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null,
  })
}

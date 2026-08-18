export const TOOL_RISK_CLASSES = Object.freeze({ READ: 'read', WRITE_LOCAL: 'write_local', EXEC: 'exec', EXTERNAL: 'external' })
export const TOOL_RISK_LEVELS = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' })

const VALID = new Set(Object.values(TOOL_RISK_CLASSES))
const VALID_LEVELS = new Set(Object.values(TOOL_RISK_LEVELS))
const VALID_SOURCES = new Set(['declared', 'fallback'])
const INTERRUPT_BEHAVIORS = new Set(['cancel', 'block'])
const DEFAULT_LEVEL_BY_CATEGORY = Object.freeze({
  [TOOL_RISK_CLASSES.READ]: TOOL_RISK_LEVELS.LOW,
  [TOOL_RISK_CLASSES.WRITE_LOCAL]: TOOL_RISK_LEVELS.MEDIUM,
  [TOOL_RISK_CLASSES.EXEC]: TOOL_RISK_LEVELS.HIGH,
  [TOOL_RISK_CLASSES.EXTERNAL]: TOOL_RISK_LEVELS.HIGH,
})

function defaultGetPath(args = {}) {
  if (!args || typeof args !== 'object') return null
  for (const key of ['path', 'cwd', 'repository', 'repo', 'url', 'target']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim()
  }
  return null
}

export function normalizeToolRiskMetadata(metadata, { origin = 'dynamic', source = null } = {}) {
  const value = metadata && typeof metadata === 'object' ? metadata : {}
  const category = VALID.has(value.category)
    ? value.category
    : (VALID.has(value.riskClass) ? value.riskClass : TOOL_RISK_CLASSES.EXTERNAL)
  const riskLevel = VALID_LEVELS.has(value.riskLevel)
    ? value.riskLevel
    : DEFAULT_LEVEL_BY_CATEGORY[category]
  const metadataSource = VALID_SOURCES.has(value.source)
    ? value.source
    : (VALID_SOURCES.has(source) ? source : (metadata && typeof metadata === 'object' ? 'declared' : 'fallback'))
  const isReadOnly = value.isReadOnly == null
    ? (value.readOnly == null ? category === TOOL_RISK_CLASSES.READ : value.readOnly === true)
    : value.isReadOnly === true
  const isConcurrencySafe = value.isConcurrencySafe == null ? isReadOnly : value.isConcurrencySafe === true
  const isIdempotent = value.isIdempotent == null ? isReadOnly : value.isIdempotent === true
  const interruptBehavior = INTERRUPT_BEHAVIORS.has(value.interruptBehavior)
    ? value.interruptBehavior
    : (isReadOnly ? 'cancel' : 'block')
  const isDestructive = value.isDestructive == null
    ? [TOOL_RISK_CLASSES.EXEC, TOOL_RISK_CLASSES.EXTERNAL].includes(category)
    : value.isDestructive === true
  const approvalDeclaration = value.requiredApproval ?? value.requiresApproval
  const requiredApproval = approvalDeclaration == null
    ? category !== TOOL_RISK_CLASSES.READ
    : approvalDeclaration === true
  return Object.freeze({
    riskLevel,
    category,
    riskClass: category,
    requiredApproval,
    requiresApproval: requiredApproval,
    isReadOnly,
    readOnly: isReadOnly,
    isConcurrencySafe,
    isIdempotent,
    interruptBehavior,
    isDestructive,
    getPath: typeof value.getPath === 'function' ? value.getPath : defaultGetPath,
    origin,
    source: metadataSource,
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null,
  })
}

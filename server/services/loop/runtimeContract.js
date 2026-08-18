export const LOOP_RUNTIME_CONTRACT_ERROR_CODE = 'LOOP_RUNTIME_CONTRACT_VIOLATION'

const CORE_DEPENDENCY_SCHEMA = Object.freeze({
  createCheckpointBarrier: 'function',
  createJobBudget: 'function',
  createSteeringController: 'function',
  createToolLoopGuard: 'function',
  executeServerTool: 'function',
  normalizeCompactionRecovery: 'function',
  normalizeToolCalls: 'function',
  resolveIterationWindow: 'function',
  runModelStep: 'function',
})

const STAGE_SCHEMAS = Object.freeze({
  'execute-tool-calls': Object.freeze({
    iteration: 'object',
    'iteration.toolCalls': 'array',
  }),
  'create-outcome-recorder': Object.freeze({
    iteration: 'object',
    'iteration.markCall': 'function',
    'iteration.observeFailureRecovery': 'function',
  }),
  'complete-tool-batch': Object.freeze({
    iteration: 'object',
    'iteration.toolCalls': 'array',
    'iteration.executeOne': 'function',
    'iteration.markCall': 'function',
    'iteration.observeFailureRecovery': 'function',
    'iteration.recordOutcome': 'function',
  }),
  'checkpoint-state': Object.freeze({
    budget: 'object',
    'budget.snapshot': 'function',
    loopGuard: 'object',
    'loopGuard.snapshot': 'function',
  }),
})

function valueAtPath(value, path) {
  return path.split('.').reduce(
    (current, key) => (current == null ? undefined : current[key]),
    value,
  )
}

function matchesType(value, expectedType) {
  if (expectedType === 'array') return Array.isArray(value)
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === expectedType
}

function assertSchema(value, stage, schema) {
  const missingFields = []
  const invalidFields = []
  for (const [path, expectedType] of Object.entries(schema)) {
    const fieldValue = valueAtPath(value, path)
    if (fieldValue === undefined) missingFields.push(path)
    else if (!matchesType(fieldValue, expectedType)) invalidFields.push(path)
  }
  if (missingFields.length === 0 && invalidFields.length === 0) return

  const details = [
    missingFields.length ? `missing ${missingFields.join(', ')}` : '',
    invalidFields.length ? `invalid ${invalidFields.join(', ')}` : '',
  ].filter(Boolean).join('; ')
  const error = new Error(`Loop runtime contract violation in ${stage}: ${details}`)
  error.name = 'LoopRuntimeContractError'
  error.code = LOOP_RUNTIME_CONTRACT_ERROR_CODE
  error.stage = stage
  error.missingFields = missingFields
  error.invalidFields = invalidFields
  throw error
}

export function assertRuntimeDependencies(dependencies) {
  assertSchema(dependencies, 'runtime-dependencies', CORE_DEPENDENCY_SCHEMA)
}

export function assertRuntimeStage(state, stage) {
  const schema = STAGE_SCHEMAS[stage]
  if (!schema) throw new TypeError(`Unknown loop runtime stage contract: ${stage}`)
  assertSchema(state, stage, schema)
}

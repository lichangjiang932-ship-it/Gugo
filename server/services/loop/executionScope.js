// @ts-check
import path from 'node:path'

/**
 * @typedef {Readonly<{
 * version: 1, userId: string | null, sessionId: string | null,
 * jobId: string | null, stepId: string | null, projectDirectory: string | null,
 * modelName: string | null, modelProviderId: string | null
 * }>} LoopExecutionScope
 */
/** @typedef {Readonly<{id?: string | null, userId?: string | null, sessionId?: string | null, modelName?: string | null, modelProviderId?: string | null}>} ScopeSource */

/** @param {unknown} value */
function text(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.includes('\0')) {
    throw Object.assign(new TypeError('Invalid execution scope identity.'), {
      code: 'LOOP_EXECUTION_SCOPE_INVALID',
    })
  }
  return value.trim() || null
}

/**
 * Capability/credential environments never belong to this serializable scope.
 * It carries the host's identity and selected project/model provenance.
 *
 * @param {{job?: ScopeSource | null, step?: ScopeSource | null, projectDirectory?: string | null}} [input]
 * @returns {LoopExecutionScope}
 */
export function createLoopExecutionScope({ job = null, step = null, projectDirectory = null } = {}) {
  const root = text(projectDirectory)
  if (root && !path.isAbsolute(root) && !/^[a-z]:[\\/]/iu.test(root)) {
    throw Object.assign(new TypeError('Execution scope requires an absolute project directory.'), {
      code: 'LOOP_EXECUTION_SCOPE_INVALID',
    })
  }
  return Object.freeze({
    version: 1,
    userId: text(job?.userId),
    sessionId: text(job?.sessionId),
    jobId: text(job?.id),
    stepId: text(step?.id),
    projectDirectory: root,
    modelName: text(job?.modelName),
    modelProviderId: text(job?.modelProviderId),
  })
}

/**
 * Refuse an identity/model drift before the next phase can request a model or
 * execute tools. Project updates are host-derived at directory boundaries.
 *
 * @param {LoopExecutionScope} scope
 * @param {{job?: ScopeSource | null, step?: ScopeSource | null}} state
 */
export function assertLoopExecutionScope(scope, state) {
  const expected = createLoopExecutionScope({ ...state, projectDirectory: scope.projectDirectory })
  for (const key of /** @type {const} */ ([
    'version', 'userId', 'sessionId', 'jobId', 'stepId', 'modelName', 'modelProviderId',
  ])) {
    if (scope[key] !== expected[key]) {
      throw Object.assign(new TypeError(`Execution scope changed at ${key}.`), {
        code: 'LOOP_EXECUTION_SCOPE_DRIFT', retryable: false,
      })
    }
  }
}

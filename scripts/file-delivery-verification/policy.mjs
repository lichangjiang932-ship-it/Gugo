import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

const FILE_TOOLS = new Set(['list_directory', 'read_file', 'write_file'])
const SAFE_TOOLS = new Set([...FILE_TOOLS, 'create_docx', 'set_deliverables'])
const STOP_REASONS = new Set(['cancelled', 'permission_denied', 'request_unknown', 'request_limit', 'endpoint_denied'])

function refusal(code, message) {
  return Object.assign(new Error(message), {
    code, retryable: false, unsafeToReplay: true, modelRequestOutcome: 'not_sent',
  })
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function assertWorkspacePath(workspace, raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw refusal('FILE_DELIVERY_PATH_DENIED', 'Verification requires a workspace file path')
  }
  const target = path.resolve(workspace, raw)
  if (!isInside(workspace, target)) {
    throw refusal('FILE_DELIVERY_PATH_DENIED', 'Verification path is outside its workspace')
  }
  let parent = target
  while (!existsSync(parent)) {
    const next = path.dirname(parent)
    if (next === parent) throw refusal('FILE_DELIVERY_PATH_DENIED', 'Verification path cannot be resolved')
    parent = next
  }
  if (!isInside(workspace, realpathSync(parent))) {
    throw refusal('FILE_DELIVERY_PATH_DENIED', 'Verification path resolves outside its workspace')
  }
}

/** A restrictive experimental host policy, not a replacement for production authorization. */
export function createFileDeliveryPolicy({ workspace, allowedTools = [], maxRequests = 12, modelBaseUrl = '' } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new TypeError('Verification workspace must be absolute')
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 12) throw new TypeError('Verification request budget must be 1..12')
  if (!Array.isArray(allowedTools) || allowedTools.some(name => !SAFE_TOOLS.has(name))) throw new TypeError('Unsafe verification tool')
  const root = realpathSync(workspace)
  const tools = new Set(allowedTools)
  const endpoint = modelBaseUrl ? new URL(modelBaseUrl) : null
  let physicalRequests = 0
  let stopped = false
  let reason = ''
  const assertRunning = () => {
    if (stopped) throw refusal('FILE_DELIVERY_STOPPED', 'File delivery verification is stopped')
  }
  const stop = value => { stopped = true; reason = STOP_REASONS.has(value) ? value : 'request_unknown' }
  const assertToolCall = (name, args = {}) => {
    assertRunning()
    try {
      if (!tools.has(name)) throw refusal('FILE_DELIVERY_TOOL_DENIED', 'Tool is not permitted by the verification host')
      if (FILE_TOOLS.has(name)) assertWorkspacePath(root, args.path)
      if (name === 'create_docx') {
        if (args.output_directory) assertWorkspacePath(root, args.output_directory)
        if (args.images?.length || args.replace_artifact_id) {
          throw refusal('FILE_DELIVERY_TOOL_DENIED', 'Verification does not import images or replace existing artifacts')
        }
      }
    } catch (error) {
      stop('permission_denied')
      throw error
    }
  }
  const reservePhysicalRequest = (url) => {
    assertRunning()
    if (endpoint) {
      const target = new URL(url)
      if (target.origin !== endpoint.origin || target.username || target.password) {
        stop('endpoint_denied')
        throw refusal('FILE_DELIVERY_ENDPOINT_DENIED', 'Verification cannot change model endpoint')
      }
    }
    if (physicalRequests >= maxRequests) {
      stop('request_limit')
      throw refusal('FILE_DELIVERY_REQUEST_LIMIT', 'File delivery verification request budget exhausted')
    }
    physicalRequests += 1
    return physicalRequests
  }
  return Object.freeze({
    assertToolCall,
    reservePhysicalRequest,
    beforeModelRequest: reservePhysicalRequest,
    projectToolSpecs: specs => specs.filter(spec => tools.has(spec?.function?.name)),
    wrapDispatcher: dispatch => async (name, args, ...rest) => {
      assertToolCall(name, args)
      return dispatch(name, args, ...rest)
    },
    stop,
    snapshot: () => ({ physicalRequests, maxRequests, stopped, reason }),
  })
}

import { grantLocalPathApi } from './localFileAccessClient.js'
import { resumeJobDirectoryAuthorization } from './jobClient.js'

const VALID_ACCESS_MODES = new Set(['read_only', 'read_write'])
const VALID_SCOPES = new Set(['session', 'persistent'])

export async function authorizeRequestedDirectory({
  jobId,
  path = '',
  accessMode = 'read_only',
  scope = 'session',
  purpose = '',
} = {}, {
  grantPath = grantLocalPathApi,
  resume = resumeJobDirectoryAuthorization,
} = {}) {
  if (!jobId) throw new Error('jobId is required')
  if (!VALID_ACCESS_MODES.has(accessMode)) throw new Error('invalid directory access mode')
  if (!VALID_SCOPES.has(scope)) throw new Error('invalid directory authorization scope')

  const selectedPath = String(path || '').trim()
  if (!selectedPath) throw new Error('directory path is required')

  // The durable job is resumed only after the grant has committed.
  const grantResult = await grantPath({ path: selectedPath, accessMode, scope })
  const result = await resume(jobId, { path: selectedPath, accessMode, purpose })
  return {
    ...result,
    cancelled: false,
    path: selectedPath,
    accessMode,
    scope: grantResult?.grant?.scope || scope,
  }
}

import { grantLocalPathApi, pickLocalDirectoryApi } from './localFileAccessClient.js'
import { resumeJobDirectoryAuthorization } from './jobClient.js'

const VALID_ACCESS_MODES = new Set(['read_only', 'read_write'])

export async function authorizeRequestedDirectory({
  jobId,
  path = '',
  accessMode = 'read_only',
  purpose = '',
  usePicker = false,
} = {}, {
  pickDirectory = pickLocalDirectoryApi,
  grantPath = grantLocalPathApi,
  resume = resumeJobDirectoryAuthorization,
} = {}) {
  if (!jobId) throw new Error('jobId is required')
  if (!VALID_ACCESS_MODES.has(accessMode)) throw new Error('invalid directory access mode')

  let selectedPath = String(path || '').trim()
  if (usePicker) {
    const picked = await pickDirectory()
    selectedPath = String(picked?.path || '').trim()
    if (!selectedPath) return { cancelled: true }
  }
  if (!selectedPath) throw new Error('directory path is required')

  // The durable job is resumed only after the grant has committed.
  await grantPath({ path: selectedPath, accessMode })
  const result = await resume(jobId, { path: selectedPath, accessMode, purpose })
  return { ...result, cancelled: false, path: selectedPath, accessMode }
}

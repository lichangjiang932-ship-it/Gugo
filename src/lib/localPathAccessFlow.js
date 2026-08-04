import { getLocalFileAccessApi } from './localFileAccessClient.js'
import { buildLocalPathPreflight, isLocalPathAuthorized } from './localPathPreflight.js'
import { executeToolCall } from './tools/index.js'

export function createLocalPathAccessEnsurer(requestDirectoryApproval, {
  getAccessStatus = getLocalFileAccessApi,
} = {}) {
  return async function ensureLocalPathAccess(content) {
    const request = buildLocalPathPreflight(content)
    if (!request.paths.length) return { proceed: true, ...request }

    let status = null
    try {
      status = await getAccessStatus()
    } catch {
      // A successful grant below remains authoritative when lookup is unavailable.
    }

    for (const path of request.paths) {
      if (isLocalPathAuthorized(path, status, request.accessMode)) continue
      const decision = await requestDirectoryApproval({
        path,
        suggestGrantPath: path,
        requiredAccessMode: request.accessMode,
        source: 'message_preflight',
      })
      if (!decision?.approved) return { proceed: false, ...request }
      status = {
        ...(status || {}),
        grants: [...(status?.grants || []), {
          path: decision.path || path,
          accessMode: decision.accessMode || request.accessMode,
          resourceType: decision.resourceType || 'directory',
          available: true,
        }],
      }
    }
    return { proceed: true, ...request }
  }
}

export function createLocalPathAccessProbe(lang, { execute = executeToolCall } = {}) {
  return async function probeLocalPathAccess(localPathAccess) {
    const paths = Array.isArray(localPathAccess?.paths) ? localPathAccess.paths.slice(0, 3) : []
    return Promise.all(paths.map(async (path, index) => {
      const listResult = await execute({
        id: `local-path-list-${index}`,
        name: 'list_directory',
        arguments: JSON.stringify({ path, limit: 200 }),
      }, { maxRetries: 0, lang })
      if (listResult.ok) return { path, tool: 'list_directory', ok: true, content: listResult.content }

      const readResult = await execute({
        id: `local-path-read-${index}`,
        name: 'read_file',
        arguments: JSON.stringify({ path, offset: 0, limit: 240 }),
      }, { maxRetries: 0, lang })
      if (readResult.ok) return { path, tool: 'read_file', ok: true, content: readResult.content }
      return {
        path,
        tool: 'local_path_probe',
        ok: false,
        content: JSON.stringify({
          listDirectoryError: listResult.content,
          readFileError: readResult.content,
        }),
      }
    }))
  }
}

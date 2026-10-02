// Claude-Code 风格的 fs / shell 工具公共入口。
// 实现按授权路径、文件操作、Shell 执行、产物核验和工具规格拆分；调用方继续只依赖本文件。

import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  resolveForFileTool,
  resolveForShellCwd,
  resolveInWorkspace,
} from './fsShellSupport.js'
import {
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from './fsFileTools.js'
import { bashExecTool } from './fsShellExecution.js'
import { FS_SHELL_TOOL_SPECS } from './fsShellToolSpecs.js'

export {
  resolveForFileTool,
  resolveForShellCwd,
  resolveInWorkspace,
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
  bashExecTool,
  FS_SHELL_TOOL_SPECS,
}

// The HTTP face carries what a person in the app actually uses: listing and
// reading (local-path probing) and the web terminal's shell. Writing and
// editing files are model tools, executed in-process behind the approval
// gate — they have no HTTP route. Paths match exactly, so no longer path
// that merely starts with one of these reaches a handler.
const HTTP_ROUTES = new Map([
  ['/api/tools/fs/list', listDirectoryTool],
  ['/api/tools/fs/read', readFileTool],
  ['/api/tools/shell/exec', bashExecTool],
])

export async function handleFsShellRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    return
  }
  if (!authenticateRequest(req)) {
    sendJson(res, 401, { ok: false, error: '请先登录' })
    return
  }
  const route = HTTP_ROUTES.get(String(req.url || '').split('?')[0])
  if (!route) {
    sendJson(res, 404, { ok: false, error: '未知端点' })
    return
  }
  try {
    const body = await readJson(req)
    const result = await route({ ...body, userId: req.userId })
    sendJson(res, 200, result)
  } catch (error) {
    const status = error?.statusCode || 500
    sendJson(res, status, {
      ok: false,
      code: error?.code || 'FS_TOOL_FAILED',
      error: error?.message || 'tool failed',
      retryable: error?.retryable ?? ![401, 403, 404].includes(status),
      ...(error?.path ? { path: error.path } : {}),
      ...(error?.hint ? { hint: error.hint } : {}),
      ...(error?.suggestGrantPath ? { suggestGrantPath: error.suggestGrantPath } : {}),
      ...(error?.requiredAccessMode ? { requiredAccessMode: error.requiredAccessMode } : {}),
    })
  }
}

export async function dispatchFsShellTool(name, args, {
  userId = null,
  signal = null,
  onOutput = null,
  idempotentResume = false,
  sideEffectRecoveryPlan = null,
} = {}) {
  const argsWithUser = userId ? { ...args, userId } : args
  switch (name) {
    case 'list_directory': return listDirectoryTool(argsWithUser)
    case 'read_file': return readFileTool(argsWithUser)
    case 'write_file': return writeFileTool(argsWithUser, { idempotentResume, sideEffectRecoveryPlan })
    case 'edit_file': return editFileTool(argsWithUser)
    case 'bash_exec': return bashExecTool({ ...argsWithUser, signal, onOutput })
    default: throw new Error(`unknown fsShell tool: ${name}`)
  }
}

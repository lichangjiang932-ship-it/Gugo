import { isToolPermittedForUser } from '../db.js'
import { writeToolAudit } from '../utils/audit.js'

export function assertGitToolPermitted(userId, toolName) {
  if (!userId || isToolPermittedForUser(userId, toolName)) return
  const error = new Error(`工具 ${toolName} 已被该用户在权限中心关闭`)
  error.statusCode = 403
  error.code = 'TOOL_DISABLED'
  throw error
}

export async function runAuditedProjectCheckHttp({ body, userId, execute }) {
  const startedAt = Date.now()
  try {
    const result = await execute({ ...(body || {}), userId })
    writeToolAudit({
      userId,
      origin: 'git',
      toolName: 'run_project_check',
      args: body,
      result,
      status: result?.ok === true ? 'ok' : 'error',
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (error) {
    writeToolAudit({
      userId,
      origin: 'git',
      toolName: 'run_project_check',
      args: body,
      result: { code: error?.code, error: error?.message },
      status: error?.statusCode === 403 ? 'denied' : 'error',
      durationMs: Date.now() - startedAt,
    })
    throw error
  }
}

import { getAuthToken } from './accountClient.js'

// 可被 gate 的真实后端工具(与服务端 GATEABLE_TOOLS 对齐)。
export const GATEABLE_TOOLS = [
  { id: 'bash_exec', name: '命令执行', code: 'SHELL', scope: 'workspace shell' },
  {
    id: 'run_code',
    nameKey: 'permissionsDashboard.toolRunCodeName',
    code: 'CODE',
    scopeKey: 'permissionsDashboard.toolRunCodeScope',
  },
  { id: 'write_file', name: '文件写入', code: 'WRITE', scope: 'workspace 写文件' },
  { id: 'edit_file', name: '文件编辑', code: 'EDIT', scope: 'workspace 改文件' },
]

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function parse(res) {
  let data
  try { data = await res.json() } catch { data = null }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败：HTTP ${res.status}`)
  }
  return data
}

// 返回 { toolName: boolean } 显式覆盖 map(未覆盖的工具默认放行)。
export async function fetchToolPermissions({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/tool-permissions', { headers: authHeaders() })
  const data = await parse(res)
  return data.permissions || {}
}

export async function setToolPermission(toolName, enabled, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/tool-permissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ toolName, enabled }),
  })
  const data = await parse(res)
  return data.permissions || {}
}

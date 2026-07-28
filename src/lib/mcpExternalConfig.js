export const MCP_EXTERNAL_APPS = Object.freeze([
  { id: 'claude', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'cline', label: 'Cline' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'cherry', label: 'Cherry Studio' },
  { id: 'codex', label: 'Codex' },
])

export const MCP_ACCESS_KEY_PLACEHOLDER = 'ymak_YOUR_ACCESS_KEY'

function serverConfig(endpoint, authorization, extra = {}) {
  return {
    ...extra,
    url: endpoint,
    headers: { Authorization: authorization },
  }
}

function jsonConfig(root, config) {
  return JSON.stringify({ [root]: { gugo: config } }, null, 2)
}

export function buildExternalMcpConfig(appId, endpoint, accessKey = '') {
  const key = accessKey.trim() || MCP_ACCESS_KEY_PLACEHOLDER
  const authorization = `Bearer ${key}`

  switch (appId) {
    case 'claude':
      return jsonConfig('mcpServers', serverConfig(endpoint, authorization, { type: 'http' }))
    case 'cursor':
      return jsonConfig('mcpServers', serverConfig(endpoint, authorization))
    case 'vscode':
      return jsonConfig('servers', serverConfig(endpoint, authorization, { type: 'http' }))
    case 'cline':
      return jsonConfig('mcpServers', serverConfig(endpoint, authorization, { type: 'streamableHttp' }))
    case 'windsurf':
      return jsonConfig('mcpServers', {
        serverUrl: endpoint,
        headers: { Authorization: authorization },
      })
    case 'cherry':
      return `Transport: Streamable HTTP\nURL: ${endpoint}\nHeaders:\nAuthorization: ${authorization}`
    case 'codex':
      return `[mcp_servers.gugo]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(authorization)} }`
    default:
      throw new TypeError(`Unsupported MCP application: ${appId}`)
  }
}

export function isValidMcpAccessKey(accessKey) {
  return accessKey.trim() === '' || /^ymak_[A-Za-z0-9_-]+$/.test(accessKey.trim())
}

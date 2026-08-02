export const MCP_SERVER_PRESETS = Object.freeze([
  Object.freeze({
    id: 'chrome-devtools',
    provider: 'mcp_chrome_devtools',
    label: 'Chrome DevTools',
    publisher: 'Google',
    brandColor: '#1A73E8',
    category: 'work',
    searchTerms: 'chrome chromium browser devtools google mcp debugging automation',
    descriptionKey: 'access.chromeDevtoolsMcpDesc',
    hintKey: 'access.chromeDevtoolsMcpHint',
    official: true,
    name: 'chrome_devtools',
    transport: 'stdio',
    command: 'npx',
    args: Object.freeze(['-y', 'chrome-devtools-mcp@latest']),
    env: Object.freeze({}),
    cwd: '',
    url: '',
    headers: Object.freeze({}),
    enabled: true,
    autoApprove: Object.freeze([]),
  }),
  Object.freeze({
    id: 'filesystem',
    provider: 'mcp_filesystem',
    label: 'Filesystem',
    publisher: 'Model Context Protocol',
    brandColor: '#64748B',
    category: 'productivity',
    searchTerms: 'filesystem files folders local mcp reference server',
    descriptionKey: 'access.filesystemMcpDesc',
    hintKey: 'access.filesystemMcpHint',
    official: true,
    showInAccess: false,
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-filesystem', '.']),
    env: Object.freeze({}),
    cwd: '',
    url: '',
    headers: Object.freeze({}),
    enabled: true,
    autoApprove: Object.freeze([]),
  }),
])

export function getMcpServerPreset(id) {
  return MCP_SERVER_PRESETS.find((item) => item.id === id) || null
}

export function findInstalledMcpPreset(servers, presetId) {
  const preset = getMcpServerPreset(presetId)
  if (!preset) return null
  return (Array.isArray(servers) ? servers : []).find((server) => server.name === preset.name) || null
}

export function createMcpServerFromPreset(id) {
  const preset = getMcpServerPreset(id)
  if (!preset) return null
  return {
    name: preset.name,
    transport: preset.transport,
    command: preset.command,
    args: [...preset.args],
    env: { ...preset.env },
    cwd: preset.cwd,
    url: preset.url,
    headers: { ...preset.headers },
    headersText: JSON.stringify(preset.headers, null, 2),
    enabled: preset.enabled,
    autoApprove: [...preset.autoApprove],
  }
}

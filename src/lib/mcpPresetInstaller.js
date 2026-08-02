import {
  connectMcpServerApi,
  testMcpServerApi,
  upsertMcpServerApi,
} from './mcpClient.js'
import { createMcpServerFromPreset } from './mcpPresets.js'

const DEFAULT_API = Object.freeze({
  connect: connectMcpServerApi,
  test: testMcpServerApi,
  upsert: upsertMcpServerApi,
})

export async function installMcpPreset({ presetId, existingServer, api = DEFAULT_API }) {
  const preset = createMcpServerFromPreset(presetId)
  if (!preset) throw new Error('MCP_PRESET_MISSING')
  delete preset.headersText

  let stagedServer = null
  try {
    const staged = await api.upsert({
      ...preset,
      id: existingServer?.id,
      enabled: false,
    })
    stagedServer = staged.server
    const tested = await api.test(stagedServer.id)
    const enabled = await api.upsert({ ...stagedServer, enabled: true })
    const connected = await api.connect(stagedServer.id)
    return {
      server: enabled.server,
      runtime: {
        serverId: stagedServer.id,
        name: stagedServer.name,
        connected: connected.connected,
        tools: tested.capabilities?.tools || [],
        resources: tested.capabilities?.resources || [],
        prompts: tested.capabilities?.prompts || [],
      },
    }
  } catch (error) {
    if (stagedServer) {
      try {
        const disabled = await api.upsert({ ...stagedServer, enabled: false })
        error.disabledServer = disabled.server
      } catch {
        error.disabledServer = stagedServer
      }
    }
    throw error
  }
}

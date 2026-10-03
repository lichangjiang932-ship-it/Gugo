import { listUserToolSpecs } from '../mcp/mcpManager.js'
import { listRegisteredBrowserToolSpecs } from './browserTools.js'
import { getBuiltinSpec, listAllSpecs } from './toolRegistry.js'
import { selectedSkillsHaveResources } from './skillResourceRuntime.js'
import { SKILL_RESOURCE_TOOL_NAME } from '../utils/skillResourceToolSpecs.js'

export { SKILL_RESOURCE_TOOL_NAME }

/** Discover resource-backed schemas; the caller retains availability and permission projection. */
export async function discoverTurnToolResources({ userId, skillIds = [] } = {}) {
  const discoveryIssues = []
  let skillResourceSpec = null
  try {
    if (selectedSkillsHaveResources({ userId, skillIds })) {
      skillResourceSpec = getBuiltinSpec(SKILL_RESOURCE_TOOL_NAME)
    }
  } catch {
    discoveryIssues.push({ source: 'skills', reason: 'resource_discovery_failed' })
  }
  let mcpSpecs = []
  try {
    const result = await listUserToolSpecs(userId)
    mcpSpecs = Array.isArray(result?.specs) ? result.specs : []
    for (const issue of Array.isArray(result?.errors) ? result.errors : []) {
      discoveryIssues.push({ source: 'mcp', reason: issue.code || 'discovery_failed', serverId: issue.serverId })
    }
  } catch {
    discoveryIssues.push({ source: 'mcp', reason: 'discovery_failed' })
  }
  let browserSpecs = []
  try {
    browserSpecs = listRegisteredBrowserToolSpecs()
  } catch {
    discoveryIssues.push({ source: 'browser', reason: 'discovery_failed' })
  }
  let runtimeSpecs = []
  try {
    // MCP connection startup happens first. Then observe current global and
    // tenant-scoped plugin registrations without importing unrelated origins.
    runtimeSpecs = listAllSpecs({ userId })
      .filter((entry) => entry?.origin === 'plugin')
      .map((entry) => entry?.tool)
      .filter(Boolean)
  } catch {
    discoveryIssues.push({ source: 'runtime_registry', reason: 'discovery_failed' })
  }
  return { mcpSpecs, browserSpecs, runtimeSpecs, skillResourceSpec, discoveryIssues }
}

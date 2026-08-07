import { AGENT_TOOL_SPECS } from './agentToolSpecs.js'
import { ARTIFACT_TOOL_SPECS } from './artifactToolSpecs.js'
import { WORKSPACE_TOOL_SPECS } from './workspaceToolSpecs.js'

export const TOOL_SPECS = {
  ...WORKSPACE_TOOL_SPECS,
  ...ARTIFACT_TOOL_SPECS,
  ...AGENT_TOOL_SPECS,
}

const READ_ONLY_MODE_TOOLS = new Set(['web_search', 'fetch_url', 'list_directory', 'read_file', 'git_status', 'git_diff', 'manage_todos', 'Agent'])
const CODE_MODE_TOOLS = ['list_directory', 'read_file', 'write_file', 'edit_file', 'bash_exec', 'git_status', 'git_diff', 'run_project_check', 'manage_todos', 'Agent']

function sortToolSpecsByName(specs = []) {
  return [...specs].sort((a, b) => {
    const aName = String(a?.function?.name || '')
    const bName = String(b?.function?.name || '')
    return aName < bName ? -1 : aName > bName ? 1 : 0
  })
}

export function resolveToolsForMode(toolsConfig = {}, mode = 'chat') {
  const enabled = Object.entries(toolsConfig || {})
    .filter(([, on]) => !!on)
    .map(([name]) => name)

  if (mode === 'plan') {
    return enabled.filter((name) => READ_ONLY_MODE_TOOLS.has(name))
  }

  if (mode === 'code') {
    return [...new Set([...enabled, ...CODE_MODE_TOOLS])]
  }

  return enabled
}

export function buildToolSpecs(enabledNames) {
  // \u63a5\u53d7 Array / Set / \u4efb\u4f55 iterable;\u53bb\u91cd\u9632\u540c\u4e00 spec \u88ab\u585e\u8fdb\u4e24\u904d
  // (#18 \u7528\u6237\u5728\u6743\u9650\u4e2d\u5fc3\u53ef\u80fd\u52fe\u9009\u8fc7 + toolsConfig \u4e5f\u5f00\u4e86\u91cd\u590d\u6765\u6e90)
  const seen = new Set()
  const list = []
  for (const name of enabledNames || []) {
    if (typeof name !== 'string') continue
    if (seen.has(name)) continue
    seen.add(name)
    const spec = TOOL_SPECS[name]
    if (spec) {
      list.push(spec)
    } else if (typeof console !== 'undefined') {
      console.warn(spec
        ? `[tools] Tool without an executor was ignored: ${name}`
        : `[tools] \u672a\u77e5\u5de5\u5177\u88ab\u5ffd\u7565: ${name}`)
    }
  }
  return sortToolSpecsByName(list)
}

export function listToolNames() {
  return Object.keys(TOOL_SPECS)
}

/* \u2500\u2500 \u6267\u884c\u5668 \u2500\u2500 */


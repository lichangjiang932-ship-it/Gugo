import {
  getBoundRuntimeTool,
  getRuntimeCapabilitySnapshot,
} from '../core/runtimeCapabilityState.js'
import { authenticateRequest } from '../middleware.js'
import { isCodexAppServerModelCatalogAvailable } from '../services/codexAppServerRuntime.js'
import { hasConfiguredLspProvider } from '../services/lspRuntime.js'
import { isToolVisibleInPermissionMode } from './approvalPolicy.js'
import { listVisibleDynamicTools } from './toolSchemaDynamicRegistry.js'

const CODE_MODE_TOOLS = [
  'run_code',
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'lsp',
  'bash_exec',
  'run_command',
  'git_status',
  'git_diff',
  'run_project_check',
  'run_test',
  'docker_exec',
  'file_download',
  'git_write',
  'set_deliverables',
  'reflect',
  'request_clarification',
  'Agent',
]

export function createToolSchemaResolution({
  builtinCatalog,
  codexModelsToolName,
  getToolMetadata,
}) {
  function listAllSpecs({ userId = null } = {}) {
    const visibleDynamic = listVisibleDynamicTools({ userId })
    const capabilitySnapshot = getRuntimeCapabilitySnapshot()
    const selectedPluginNames = new Set()
    if (capabilitySnapshot) {
      for (const [name, info] of visibleDynamic) {
        if (info.origin === 'plugin' && getBoundRuntimeTool(name)?.exec === info.exec) {
          selectedPluginNames.add(name)
        }
      }
    }
    const out = []
    for (const [name, spec] of Object.entries(builtinCatalog)) {
      if (name === 'lsp' && !hasConfiguredLspProvider()) continue
      if (name === codexModelsToolName && !isCodexAppServerModelCatalogAvailable()) continue
      if (selectedPluginNames.has(name)) continue
      out.push({
        origin: 'builtin',
        source: null,
        name,
        tool: spec,
        metadata: getToolMetadata(name),
      })
    }
    for (const [name, info] of visibleDynamic) {
      if (capabilitySnapshot && info.origin === 'plugin' && !selectedPluginNames.has(name)) {
        continue
      }
      out.push({
        origin: info.origin,
        source: info.source,
        name,
        tool: info.spec,
        metadata: info.metadata,
      })
    }
    // Stable order preserves provider prefix-cache hits across reconnects.
    out.sort((left, right) => {
      if (left.origin === 'builtin' && right.origin !== 'builtin') return -1
      if (left.origin !== 'builtin' && right.origin === 'builtin') return 1
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    return out
  }

  function resolveSpecsForMode(
    mode = 'chat',
    { subagentWhitelist = null, userId = null } = {},
  ) {
    const all = listAllSpecs({ userId })
    if (mode === 'plan') {
      return all.filter((entry) => (
        entry.origin === 'builtin' && isToolVisibleInPermissionMode(entry.name, 'plan')
      ))
    }
    if (mode === 'code') {
      return all.filter((entry) => {
        if (entry.origin === 'builtin') return CODE_MODE_TOOLS.includes(entry.name)
        return true
      })
    }
    if (mode?.startsWith('subagent:') && Array.isArray(subagentWhitelist)) {
      const set = new Set(subagentWhitelist)
      return all.filter((entry) => set.has(entry.name))
    }
    return all
  }

  function listBuiltinNames() {
    return Object.keys(builtinCatalog)
  }

  function listBuiltinSpecs() {
    return Object.values(builtinCatalog)
  }

  function handleToolSpecsRequest(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '仅支持 GET' }))
      return
    }
    try {
      const url = new URL(req.url, 'http://localhost')
      const mode = url.searchParams.get('mode') || 'chat'
      const userId = authenticateRequest(req)
      const specs = resolveSpecsForMode(mode, { userId })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, mode, specs }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }))
    }
  }

  return {
    handleToolSpecsRequest,
    listAllSpecs,
    listBuiltinNames,
    listBuiltinSpecs,
    resolveSpecsForMode,
  }
}

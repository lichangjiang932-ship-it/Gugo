import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

import { resolveAuthMode } from '../adapters/authAccount.js'
import {
  getPlugin,
  getRuntimePlugin,
  listPlugins,
  registerPlugin,
  unregisterPlugin,
} from '../plugins/pluginRegistry.js'
import { runTransformer } from '../plugins/pluginSandbox.js'
import {
  getRuntimePluginState,
  listRuntimePluginStates,
  recordRuntimePluginError,
  setRuntimePluginState,
} from './runtimePluginStateStore.js'

const MAX_TRANSFORMER_SOURCE_BYTES = 512 * 1024
const MAX_TRANSFORMER_INPUT_BYTES = 64 * 1024
const operations = new Map()

function serviceError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function safeErrorSummary(error) {
  const code = String(error?.code || 'RUNTIME_PLUGIN_ACTIVATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 80)
  const message = String(error?.message || '运行时插件激活失败')
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[LOCAL_PATH]')
    .replace(/\/(?:[^\s/]+\/){2,}[^\s"']*/g, '[LOCAL_PATH]')
    .slice(0, 1_000)
  return `${code}: ${message}`
}

function serializePluginOperation(pluginId, operation) {
  const previous = operations.get(pluginId) || Promise.resolve()
  const pending = previous.catch(() => {}).then(operation)
  operations.set(pluginId, pending)
  pending.finally(() => {
    if (operations.get(pluginId) === pending) operations.delete(pluginId)
  }).catch(() => {})
  return pending
}

export function runtimeTransformerToolName(pluginId) {
  const normalized = String(pluginId || '').trim().replaceAll('-', '_')
  const base = `plugin_${normalized}`
  if (base.length <= 64) return base
  const suffix = createHash('sha256').update(String(pluginId)).digest('hex').slice(0, 8)
  return `${base.slice(0, 55)}_${suffix}`
}

function transformerToolSpec(plugin, toolName) {
  return {
    type: 'function',
    function: {
      name: toolName,
      description: String(plugin.description || `Run local transformer plugin ${plugin.name}`).slice(0, 1_000),
      parameters: {
        type: 'object',
        properties: {
          input: {
            description: 'JSON-serializable input for the local transformer plugin.',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  }
}

function serializedInputSize(input) {
  try {
    return Buffer.byteLength(JSON.stringify(input), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

async function readTransformerSource(plugin) {
  let stat
  try {
    stat = await fs.stat(plugin.entryPath)
  } catch {
    throw serviceError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取', 400)
  }
  if (!stat.isFile()) {
    throw serviceError('PLUGIN_ENTRY_INVALID', '插件入口必须是文件', 400)
  }
  if (stat.size > MAX_TRANSFORMER_SOURCE_BYTES) {
    throw serviceError('PLUGIN_ENTRY_TOO_LARGE', '插件入口超过 512KB 限制', 400)
  }
  try {
    return await fs.readFile(plugin.entryPath, 'utf8')
  } catch {
    throw serviceError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取', 400)
  }
}

function requireTransformerPlugin(pluginId) {
  const plugin = getPlugin(pluginId)
  if (!plugin) throw serviceError('PLUGIN_NOT_FOUND', '插件不存在', 404)
  if (plugin.type !== 'transformer') {
    throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '仅 transformer 插件支持运行时启停', 400)
  }
  return plugin
}

async function activateTransformer(plugin) {
  const existing = getRuntimePlugin(plugin.id)
  if (existing?.state === 'active') return existing
  if (existing) {
    throw serviceError('PLUGIN_RUNTIME_STATE_CONFLICT', '插件运行时状态冲突', 409)
  }

  const source = await readTransformerSource(plugin)
  const toolName = runtimeTransformerToolName(plugin.id)
  return registerPlugin({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    contributes: [toolName],
  }, (context) => context.tools.register({
    name: toolName,
    spec: transformerToolSpec(plugin, toolName),
    exec: async (args = {}) => {
      if (!Object.hasOwn(args, 'input')) {
        return { ok: false, code: 'PLUGIN_INPUT_REQUIRED', error: 'input is required' }
      }
      if (serializedInputSize(args.input) > MAX_TRANSFORMER_INPUT_BYTES) {
        return { ok: false, code: 'PLUGIN_INPUT_TOO_LARGE', error: 'input exceeds 64KB' }
      }
      return runTransformer({
        plugin: { source },
        input: args.input,
        capabilities: plugin.capabilities || [],
      })
    },
  }))
}

function inventoryEntry(plugin, state) {
  const runtime = getRuntimePlugin(plugin?.id || state?.pluginId)
  return {
    id: plugin?.id || state.pluginId,
    name: plugin?.name || state.pluginId,
    version: plugin?.version || null,
    type: plugin?.type || null,
    available: !!plugin,
    enabled: state?.enabled === true,
    active: runtime?.state === 'active',
    runtimeState: runtime?.state || 'inactive',
    toolName: plugin?.type === 'transformer' ? runtimeTransformerToolName(plugin.id) : null,
    lastError: state?.lastError || null,
    updatedAt: state?.updatedAt || null,
  }
}

export function listRuntimePluginInventory() {
  const states = new Map(listRuntimePluginStates().map((state) => [state.pluginId, state]))
  const plugins = listPlugins({ type: 'transformer' })
  const inventory = plugins.map((plugin) => {
    const state = states.get(plugin.id) || null
    states.delete(plugin.id)
    return inventoryEntry(plugin, state)
  })
  for (const state of states.values()) inventory.push(inventoryEntry(null, state))
  return inventory.sort((left, right) => left.id.localeCompare(right.id))
}

export function enableRuntimePlugin(pluginId) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, async () => {
    const plugin = requireTransformerPlugin(id)
    setRuntimePluginState({ pluginId: id, enabled: true })
    try {
      await activateTransformer(plugin)
      const state = setRuntimePluginState({ pluginId: id, enabled: true })
      return inventoryEntry(plugin, state)
    } catch (error) {
      recordRuntimePluginError({ pluginId: id, error: safeErrorSummary(error) })
      throw error
    }
  })
}

export function disableRuntimePlugin(pluginId) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, async () => {
    const plugin = getPlugin(id)
    const currentState = getRuntimePluginState(id)
    if (plugin && plugin.type !== 'transformer') {
      throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '仅 transformer 插件支持运行时启停', 400)
    }
    if (!plugin && !currentState && !getRuntimePlugin(id)) {
      throw serviceError('PLUGIN_NOT_FOUND', '插件不存在', 404)
    }
    setRuntimePluginState({ pluginId: id, enabled: false })
    try {
      if (getRuntimePlugin(id)) await unregisterPlugin(id)
      const state = setRuntimePluginState({ pluginId: id, enabled: false })
      return inventoryEntry(plugin, state)
    } catch (error) {
      recordRuntimePluginError({ pluginId: id, error: safeErrorSummary(error) })
      throw error
    }
  })
}

export async function restoreEnabledRuntimePlugins({ env = process.env } = {}) {
  const states = listRuntimePluginStates().filter((state) => state.enabled)
  // Runtime transformer tools are process-global. Restoring them in multi-user
  // mode would expose a plugin enabled by a former local owner to every tenant.
  if (resolveAuthMode(env) !== 'local') {
    return states.map((state) => ({
      pluginId: state.pluginId,
      ok: true,
      skipped: true,
      reason: 'AUTH_MODE_NOT_LOCAL',
    }))
  }
  const results = []
  for (const state of states) {
    try {
      const restored = await serializePluginOperation(state.pluginId, async () => {
        // The startup snapshot may become stale while an explicit enable/disable
        // request is already queued. Re-read the desired state inside the same
        // per-plugin critical section so recovery can never undo a newer disable.
        if (!getRuntimePluginState(state.pluginId)?.enabled) return false
        const plugin = requireTransformerPlugin(state.pluginId)
        await activateTransformer(plugin)
        setRuntimePluginState({ pluginId: state.pluginId, enabled: true })
        return true
      })
      results.push({ pluginId: state.pluginId, ok: true, ...(restored ? {} : { skipped: true }) })
    } catch (error) {
      recordRuntimePluginError({ pluginId: state.pluginId, error: safeErrorSummary(error) })
      results.push({ pluginId: state.pluginId, ok: false, error: safeErrorSummary(error) })
    }
  }
  return results
}

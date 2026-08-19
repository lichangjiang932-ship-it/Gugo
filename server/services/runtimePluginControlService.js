import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

import { resolveAuthMode } from '../adapters/authAccount.js'
import {
  getPlugin,
  getRuntimePlugin,
  listPlugins,
  listRuntimePlugins,
  registerPlugin,
  unregisterPlugin,
} from '../plugins/pluginRegistry.js'
import { runTransformer, validateTransformer } from '../plugins/pluginSandbox.js'
import {
  getRuntimePluginState,
  listRuntimePluginStates,
  recordRuntimePluginError,
  setRuntimePluginState,
} from './runtimePluginStateStore.js'

const MAX_TRANSFORMER_SOURCE_BYTES = 512 * 1024
const MAX_TRANSFORMER_INPUT_BYTES = 64 * 1024
const operations = new Map()
const activeTransformerSources = new Map()

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
  const validation = await validateTransformer({
    plugin: { source },
    capabilities: plugin.capabilities || [],
  })
  if (!validation.ok) {
    throw serviceError(
      'PLUGIN_ACTIVATION_VALIDATION_FAILED',
      `插件源码预检失败：${String(validation.error || 'plugin_error').slice(0, 500)}`,
      400,
    )
  }
  const sourceRef = { source }
  const toolName = runtimeTransformerToolName(plugin.id)
  activeTransformerSources.set(plugin.id, sourceRef)
  try {
    return await registerPlugin({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      contributes: [`tool:${toolName}`],
    }, (context) => {
      context.lifecycle.onDispose(() => {
        if (activeTransformerSources.get(plugin.id) === sourceRef) {
          activeTransformerSources.delete(plugin.id)
        }
      })
      context.tools.register({
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
            plugin: { source: sourceRef.source },
            input: args.input,
            capabilities: plugin.capabilities || [],
          })
        },
      })
    })
  } catch (error) {
    if (activeTransformerSources.get(plugin.id) === sourceRef) {
      activeTransformerSources.delete(plugin.id)
    }
    throw error
  }
}

function runtimeManifestView({ plugin, runtime }) {
  if (runtime) {
    return {
      id: runtime.id,
      name: runtime.name,
      version: runtime.version,
      requires: [...runtime.requires],
      contributes: [...runtime.contributes],
    }
  }
  if (plugin?.type !== 'transformer') return null
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    requires: [],
    contributes: [`tool:${runtimeTransformerToolName(plugin.id)}`],
  }
}

function inventoryEntry(plugin, state, runtimeValue = null) {
  const id = plugin?.id || state?.pluginId || runtimeValue?.id
  const runtime = runtimeValue || getRuntimePlugin(id)
  const isTransformer = plugin?.type === 'transformer'
  const processOnly = !plugin && !!runtime
  return {
    id,
    name: plugin?.name || runtime?.name || state?.pluginId || id,
    version: plugin?.version || runtime?.version || null,
    type: plugin?.type || (runtime ? 'runtime' : null),
    source: isTransformer
      ? 'installed-transformer'
      : processOnly ? 'host-runtime' : 'persisted-state',
    available: !!plugin || !!runtime,
    controllable: isTransformer,
    enabled: processOnly ? runtime?.state === 'active' : state?.enabled === true,
    active: runtime?.state === 'active',
    runtimeState: runtime?.state || 'inactive',
    installedAt: runtime?.installedAt || null,
    manifest: runtimeManifestView({ plugin, runtime }),
    toolName: isTransformer ? runtimeTransformerToolName(plugin.id) : null,
    lastError: state?.lastError || null,
    updatedAt: state?.updatedAt || null,
  }
}

export function listRuntimePluginInventory() {
  const states = new Map(listRuntimePluginStates().map((state) => [state.pluginId, state]))
  const runtimes = new Map(listRuntimePlugins().map((runtime) => [runtime.id, runtime]))
  const plugins = listPlugins({ type: 'transformer' })
  const inventory = plugins.map((plugin) => {
    const state = states.get(plugin.id) || null
    const runtime = runtimes.get(plugin.id) || null
    states.delete(plugin.id)
    runtimes.delete(plugin.id)
    return inventoryEntry(plugin, state, runtime)
  })
  for (const state of states.values()) {
    const runtime = runtimes.get(state.pluginId) || null
    runtimes.delete(state.pluginId)
    inventory.push(inventoryEntry(null, state, runtime))
  }
  for (const runtime of runtimes.values()) inventory.push(inventoryEntry(null, null, runtime))
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

export function reloadRuntimePlugin(pluginId) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, async () => {
    const plugin = requireTransformerPlugin(id)
    const runtime = getRuntimePlugin(id)
    const sourceRef = activeTransformerSources.get(id)
    if (runtime?.state !== 'active' || !sourceRef) {
      throw serviceError('PLUGIN_RUNTIME_NOT_ACTIVE', '插件尚未激活，无法重新加载', 409)
    }
    try {
      const source = await readTransformerSource(plugin)
      const validation = await validateTransformer({
        plugin: { source },
        capabilities: plugin.capabilities || [],
      })
      if (!validation.ok) {
        throw serviceError(
          'PLUGIN_RELOAD_VALIDATION_FAILED',
          `插件源码预检失败：${String(validation.error || 'plugin_error').slice(0, 500)}`,
          400,
        )
      }
      sourceRef.source = source
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

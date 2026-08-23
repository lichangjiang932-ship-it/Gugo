/**
 * Plugin client — 拉 plugin 列表 / 详情。
 * 阶段 6 接入：AgentList "From template" 按钮调 listPluginsApi({type:'agent-template'})。
 * Phase 2 S4：listPromptTemplatesApi 拉 prompt-template plugin 列表，
 *           getPromptTemplateContentApi 拉 entry markdown 内容（已限 50KB）。
 */
import { authHeaders, jsonOk } from './agentClient.js'

export async function listPluginsApi({ type } = {}) {
  const qs = type ? `?type=${encodeURIComponent(type)}` : ''
  const resp = await fetch(`/api/plugins${qs}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getPluginApi(id) {
  const resp = await fetch(`/api/plugins/${encodeURIComponent(id)}`, { headers: authHeaders() })
  return jsonOk(resp)
}

const LOCAL_PLUGIN_PACKAGE_SCHEMA_VERSION = 1
const LOCAL_PLUGIN_PACKAGE_REVISION_RE = /^sha256-[a-f0-9]{64}$/
const LOCAL_PLUGIN_PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

function localPluginPackageRevision(value) {
  const revision = String(value || '').trim().toLowerCase()
  if (!LOCAL_PLUGIN_PACKAGE_REVISION_RE.test(revision)) {
    throw new TypeError('invalid local plugin package store revision')
  }
  return revision
}

function localPluginPackageId(value) {
  const pluginId = String(value || '').trim().toLowerCase()
  if (!LOCAL_PLUGIN_PACKAGE_ID_RE.test(pluginId)) {
    throw new TypeError('invalid local plugin package id')
  }
  return pluginId
}

function assertLocalPluginPackageStore(store) {
  if (
    !store
    || typeof store !== 'object'
    || Array.isArray(store)
    || store.schemaVersion !== LOCAL_PLUGIN_PACKAGE_SCHEMA_VERSION
    || !LOCAL_PLUGIN_PACKAGE_REVISION_RE.test(String(store.revision || ''))
    || !Array.isArray(store.packages)
  ) {
    throw new TypeError('unsupported local plugin package response')
  }
  for (const entry of store.packages) {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || entry.schemaVersion !== LOCAL_PLUGIN_PACKAGE_SCHEMA_VERSION
      || !LOCAL_PLUGIN_PACKAGE_ID_RE.test(String(entry.pluginId || ''))
      || typeof entry.pluginVersion !== 'string'
      || !entry.pluginVersion
      || entry.pluginVersion.length > 128
      || !LOCAL_PLUGIN_PACKAGE_REVISION_RE.test(String(entry.packageDigest || ''))
      || !Number.isSafeInteger(entry.fileCount)
      || entry.fileCount < 1
      || !Number.isSafeInteger(entry.totalBytes)
      || entry.totalBytes < 1
      || !Number.isSafeInteger(entry.installedAt)
      || entry.installedAt < 0
      || entry.publisherVerified !== false
      || entry.sourceKind !== 'local-directory'
    ) {
      throw new TypeError('unsupported local plugin package response')
    }
  }
  return store
}

function assertLocalPluginPackageResponse(data, { mutation = false } = {}) {
  if (
    !data
    || typeof data !== 'object'
    || Array.isArray(data)
    || data.schemaVersion !== LOCAL_PLUGIN_PACKAGE_SCHEMA_VERSION
  ) {
    throw new TypeError('unsupported local plugin package response')
  }
  assertLocalPluginPackageStore(data.store)
  if (data.recoveries !== undefined) {
    if (!Array.isArray(data.recoveries) || data.recoveries.some((entry) => (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !LOCAL_PLUGIN_PACKAGE_ID_RE.test(String(entry.pluginId || ''))
      || !Number.isSafeInteger(entry.generation)
      || entry.generation < 1
      || entry.operation !== 'uninstall'
      || !(
        (entry.phase === 'recovery_required' && entry.recoveryRequired === true)
        || (
          ['guarding', 'mutating', 'refreshing'].includes(entry.phase)
          && entry.recoveryRequired === false
        )
      )
      || !Number.isSafeInteger(entry.ownerPid)
      || entry.ownerPid < 0
      || !Number.isSafeInteger(entry.createdAt)
      || !Number.isSafeInteger(entry.heartbeatAt)
    ))) {
      throw new TypeError('unsupported local plugin package recovery response')
    }
  }
  if (
    mutation
    && (
      !data.result
      || typeof data.result !== 'object'
      || Array.isArray(data.result)
      || typeof data.refreshPending !== 'boolean'
      || typeof data.restartRequired !== 'boolean'
    )
  ) {
    throw new TypeError('unsupported local plugin package mutation response')
  }
  return data
}

function localPluginPackageJsonHeaders() {
  return { ...authHeaders(), 'Content-Type': 'application/json' }
}

/** List immutable packages installed in the startup-owned local package store. */
export async function listLocalPluginPackagesApi() {
  const resp = await fetch('/api/plugins/packages', { headers: authHeaders() })
  return assertLocalPluginPackageResponse(await jsonOk(resp))
}

/** Import a local directory, or explicitly replace the matching installed package. */
export async function importLocalPluginPackageApi({
  sourceDirectory,
  expectedRevision,
  replace = false,
  expectedPluginId = null,
} = {}) {
  const source = typeof sourceDirectory === 'string' ? sourceDirectory.trim() : ''
  if (!source || source.length > 4_096 || source.includes('\0')) {
    throw new TypeError('invalid local plugin package source directory')
  }
  if (typeof replace !== 'boolean') throw new TypeError('replace must be a boolean')
  const pluginId = expectedPluginId === null || expectedPluginId === undefined
    ? null
    : localPluginPackageId(expectedPluginId)
  if (replace && !pluginId) {
    throw new TypeError('expected plugin id is required for replacement')
  }
  const resp = await fetch('/api/plugins/packages/actions/import', {
    method: 'POST',
    headers: localPluginPackageJsonHeaders(),
    body: JSON.stringify({
      sourceDirectory: source,
      expectedRevision: localPluginPackageRevision(expectedRevision),
      replace,
      ...(pluginId ? { expectedPluginId: pluginId } : {}),
    }),
  })
  return assertLocalPluginPackageResponse(await jsonOk(resp), { mutation: true })
}

/** Remove an inactive, unreferenced managed package using package-store CAS. */
export async function uninstallLocalPluginPackageApi(pluginId, { expectedRevision } = {}) {
  const id = localPluginPackageId(pluginId)
  const resp = await fetch(`/api/plugins/packages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: localPluginPackageJsonHeaders(),
    body: JSON.stringify({
      expectedRevision: localPluginPackageRevision(expectedRevision),
    }),
  })
  return assertLocalPluginPackageResponse(await jsonOk(resp), { mutation: true })
}

/** Reconcile a recovery-required package barrier from locally verified state. */
export async function recoverLocalPluginPackageApi(pluginId, {
  expectedRevision,
  expectedGeneration,
} = {}) {
  const id = localPluginPackageId(pluginId)
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new TypeError('invalid local plugin package recovery generation')
  }
  const resp = await fetch(`/api/plugins/packages/${encodeURIComponent(id)}/actions/recover`, {
    method: 'POST',
    headers: localPluginPackageJsonHeaders(),
    body: JSON.stringify({
      expectedRevision: localPluginPackageRevision(expectedRevision),
      expectedGeneration,
    }),
  })
  const data = await jsonOk(resp)
  if (
    !data
    || typeof data !== 'object'
    || data.schemaVersion !== LOCAL_PLUGIN_PACKAGE_SCHEMA_VERSION
    || data.recovered !== true
    || !['installed', 'uninstalled'].includes(data.outcome)
    || !data.receipt
    || data.receipt.pluginId !== id
    || data.receipt.generation !== expectedGeneration
  ) {
    throw new TypeError('unsupported local plugin package recovery response')
  }
  assertLocalPluginPackageStore(data.store)
  return data
}

/**
 * 拉取本机 owner 可见的 runtime plugin 只读清单。
 * 返回值只含 JSON manifest 与生命周期元数据；不会加载 plugin entry 或 renderer 代码。
 */
export async function listRuntimePluginInventoryApi() {
  const resp = await fetch('/api/plugins/runtime', { headers: authHeaders() })
  const inventory = await jsonOk(resp)
  if (
    !inventory
    || typeof inventory !== 'object'
    || Array.isArray(inventory)
    || inventory.schemaVersion !== 7
    || !Array.isArray(inventory.plugins)
    || inventory.plugins.some((plugin) => (
      !plugin
      || typeof plugin !== 'object'
      || Array.isArray(plugin)
      || !/^[a-z0-9][a-z0-9-]*$/i.test(String(plugin.id || ''))
    ))
  ) {
    throw new TypeError('unsupported runtime plugin inventory response')
  }
  return inventory
}

const RUNTIME_PLUGIN_ACTIONS = Object.freeze([
  'enable',
  'disable',
  'reload',
  'revoke-permissions',
])
const RUNTIME_PLUGIN_APPROVABLE_ACTIONS = Object.freeze(['enable', 'reload'])
const RUNTIME_PLUGIN_PERMISSION_CONTRACT_VERSION = 1
const RUNTIME_PLUGIN_PERMISSION_APPROVAL_HEADER = 'X-Gugo-Plugin-Permission-Approval'
const SHA256_DIGEST_RE = /^sha256-[a-f0-9]{64}$/

export function runtimePluginPermissionChallenge(error, { pluginId, action } = {}) {
  if (error?.status !== 409 || error?.code !== 'PLUGIN_PERMISSION_APPROVAL_REQUIRED') return null
  const approval = error?.details?.permissionApproval
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return null

  const id = String(pluginId || '').trim()
  const safeAction = String(action || '').toLowerCase()
  const challengePluginId = String(approval.pluginId || '').trim()
  const approvalDigest = String(approval.approvalDigest || '').trim().toLowerCase()
  const sourceDigest = String(approval.sourceDigest || '').trim().toLowerCase()
  const pluginVersion = String(approval.pluginVersion || '').trim()
  if (
    !id
    || !RUNTIME_PLUGIN_APPROVABLE_ACTIONS.includes(safeAction)
    || approval.contractVersion !== RUNTIME_PLUGIN_PERMISSION_CONTRACT_VERSION
    || challengePluginId !== id
    || !SHA256_DIGEST_RE.test(approvalDigest)
    || !SHA256_DIGEST_RE.test(sourceDigest)
    || !pluginVersion
    || pluginVersion.length > 128
    || !Array.isArray(approval.permissions)
  ) return null

  const permissions = [...new Set(approval.permissions
    .map((permission) => String(permission || '').trim())
    .filter((permission) => permission && permission.length <= 128))]
  if (permissions.length !== approval.permissions.length) return null

  return Object.freeze({
    pluginId: id,
    action: safeAction,
    pluginVersion,
    sourceDigest,
    approvalDigest,
    permissions: Object.freeze(permissions),
  })
}

/**
 * 对本机 owner 可见的 transformer 插件执行运行时控制。
 * 仅接受白名单动作；非 loopback 或非本机 owner 时服务端返回 403。
 */
export async function runtimePluginActionApi(pluginId, action, { approvalDigest } = {}) {
  const id = String(pluginId || '').trim()
  const safeAction = String(action || '').toLowerCase()
  if (!RUNTIME_PLUGIN_ACTIONS.includes(safeAction)) {
    throw new TypeError('unsupported runtime plugin action')
  }
  const approval = String(approvalDigest || '').trim().toLowerCase()
  const includeApproval = RUNTIME_PLUGIN_APPROVABLE_ACTIONS.includes(safeAction) && approval
  if (includeApproval && !SHA256_DIGEST_RE.test(approval)) {
    throw new TypeError('invalid runtime plugin permission approval digest')
  }
  const resp = await fetch(`/api/plugins/runtime/${encodeURIComponent(id)}/${safeAction}`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      ...(includeApproval ? { [RUNTIME_PLUGIN_PERMISSION_APPROVAL_HEADER]: approval } : {}),
    },
  })
  return jsonOk(resp)
}

/**
 * 将 type='skill-bundle' 的 plugin 安装为当前用户的 skill。
 * 需登录。2xx 返 { ok:true, skill }; 其他返 { ok:false, error } 抑或抛。
 */
export async function installPluginAsSkillApi(pluginId) {
  const resp = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/install-as-skill`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

/* ── Phase 2 S4: prompt-template plugins as slash command ────────────── */

/**
 * 拉所有 type='prompt-template' 的 plugin（公开端点）。
 * 返回 [{ id, name, description, ... }]
 */
export async function listPromptTemplatesApi() {
  const data = await listPluginsApi({ type: 'prompt-template' })
  return Array.isArray(data?.plugins) ? data.plugins : []
}

/**
 * 拉 prompt-template plugin 的 entry markdown 内容。
 * 公共端点 ENTRY_PREVIEW_LIMIT=50KB 已在 server 侧限制。
 * @returns string 模板原文；找不到或非 prompt-template 返空串。
 */
export async function getPromptTemplateContentApi(id) {
  const data = await getPluginApi(id)
  if (!data?.plugin || data.plugin.type !== 'prompt-template') return ''
  const preview = data.entryPreview || {}
  if (preview.error) return ''
  return String(preview.content || '')
}

/**
 * 用 ctx 渲染 prompt-template：把 `{{var}}` 替成 ctx[var]，缺省替成空串。
 * 没有 ctx 时返回原文。
 */
export function renderPromptTemplate(content, ctx = {}) {
  const text = String(content || '')
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = ctx[key]
    return v == null ? '' : String(v)
  })
}

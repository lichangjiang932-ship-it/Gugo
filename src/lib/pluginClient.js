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

/**
 * 拉取本机 owner 可见的 runtime plugin 只读清单。
 * 返回值只含 JSON manifest 与生命周期元数据；不会加载 plugin entry 或 renderer 代码。
 */
export async function listRuntimePluginInventoryApi() {
  const resp = await fetch('/api/plugins/runtime', { headers: authHeaders() })
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

/**
 * Plugin client — 拉 plugin 列表 / 详情。
 * 阶段 6 接入：AgentList "From template" 按钮调 listPluginsApi({type:'agent-template'})。
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

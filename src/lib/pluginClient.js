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

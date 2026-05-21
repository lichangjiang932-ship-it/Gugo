/**
 * Feature 1: MCP JSON-RPC 2.0 信封
 *
 * 协议参考: https://spec.modelcontextprotocol.io
 *   - 客户端发请求 { jsonrpc:'2.0', id, method, params }
 *   - 服务端回 { jsonrpc:'2.0', id, result } / { jsonrpc:'2.0', id, error:{ code, message } }
 *   - 通知 (无 id) 不需要回复
 *
 * 客户端能力声明 — 我们暂时只声明 tools 能力，告知服务端我们可以接收
 *   tools/list 和 tools/call。resources/prompts 在未来版本扩展。
 */

let _nextId = 1
export function nextRequestId() {
  _nextId = (_nextId + 1) >>> 0
  return _nextId
}

export const CLIENT_INFO = {
  name: 'your-model-atelier',
  version: '1.0.0',
}

export const CLIENT_CAPABILITIES = {
  // 暂只声明：roots/sampling 我们都不支持
  // tools listing 通过 tools/list 调用拉取
}

export const PROTOCOL_VERSION = '2024-11-05'

export function buildInitializeRequest() {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    },
  }
}

export function buildInitializedNotification() {
  return { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }
}

export function buildToolsListRequest() {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'tools/list', params: {} }
}

export function buildToolsCallRequest(name, args) {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'tools/call',
    params: { name, arguments: args || {} },
  }
}

export function buildResourcesListRequest() {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'resources/list', params: {} }
}

export function buildPromptsListRequest() {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'prompts/list', params: {} }
}

export function buildResourceReadRequest(uri) {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'resources/read', params: { uri } }
}

export function buildPromptGetRequest(name, args) {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'prompts/get',
    params: { name, arguments: args || {} },
  }
}

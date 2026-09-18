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
  name: 'Gugo',
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

export function buildToolsListRequest(cursor) {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'tools/list', params: cursor === undefined ? {} : { cursor } }
}

export function buildToolsCallRequest(name, args, { idempotencyKey, toolCallId } = {}) {
  const meta = {
    ...(idempotencyKey ? { 'gugo/idempotencyKey': idempotencyKey } : {}),
    ...(toolCallId ? { 'gugo/toolCallId': toolCallId } : {}),
  }
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'tools/call',
    params: {
      name,
      arguments: args || {},
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    },
  }
}

export function buildResourcesListRequest(cursor) {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'resources/list', params: cursor === undefined ? {} : { cursor } }
}

export function buildPromptsListRequest(cursor) {
  return { jsonrpc: '2.0', id: nextRequestId(), method: 'prompts/list', params: cursor === undefined ? {} : { cursor } }
}

export async function readMcpList(transport, buildRequest, key, { timeoutMs = 15000, signal, optional = false } = {}) {
  const items = []
  const cursors = new Set()
  const deadline = Date.now() + timeoutMs
  let cursor
  for (let page = 0; page < 100; page += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException('MCP list cancelled', 'AbortError')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`MCP ${key}/list pagination time limit exceeded`)
    let result
    try {
      result = await transport.request(buildRequest(cursor), { timeoutMs: remaining, signal })
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error
      if (optional && page === 0 && (error?.code === -32601 || /^method not found$/i.test(error?.message))) return { [key]: [] }
      throw new Error(`MCP ${key}/list pagination request failed`, { cause: error })
    }
    if (signal?.aborted) throw signal.reason || new DOMException('MCP list cancelled', 'AbortError')
    if (Date.now() > deadline) throw new Error(`MCP ${key}/list pagination time limit exceeded`)
    if (!Array.isArray(result?.[key])) throw new Error(`MCP ${key}/list returned an invalid catalog page`)
    if (items.length + result[key].length > 10000) throw new Error(`MCP ${key}/list pagination item limit exceeded`)
    for (const item of result[key]) items.push(item)
    if (result.nextCursor === undefined) return { [key]: items }
    if (typeof result.nextCursor !== 'string') throw new Error(`MCP ${key}/list returned an invalid cursor`)
    if (cursors.has(result.nextCursor)) throw new Error(`MCP ${key}/list pagination cursor cycle detected`)
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error(`MCP ${key}/list pagination page limit exceeded`)
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

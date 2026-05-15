/**
 * 前端工具规格(OpenAI tool schema)和本地执行器(把 tool_call 路由到对应 fetch)。
 *
 * 流程:
 *   1) 前端把 buildToolSpecs(enabled) 塞进 chat 请求的 `tools` 字段
 *   2) 后端透传给上游模型,模型返回 tool_calls
 *   3) 前端 executeToolCall(call) 调本地 /api/tools/* 拿结果
 *   4) 把 { role: 'tool', tool_call_id, content } 追加到 messages,再发一轮
 */

// ★ batchF P1: /api/tools/* 现在强制鉴权,前端必须带 token,
//   否则未登录用户能直接调搜索/抓取消耗后端资源(也消耗别人的免费额度).
import { getAuthToken } from '../accountClient.js'

import { z } from 'zod'

// ★ #18: 工具参数 zod schema — 模型可能给出脏数据,先校验再执行
const TOOL_ARG_SCHEMAS = {
  web_search: z.object({
    query: z.string().min(1, 'query 不能为空').max(500, 'query 过长'),
    max_results: z.number().int().min(1).max(10).optional(),
  }),
  fetch_url: z.object({
    url: z.string().url('url 必须是合法 http/https 链接'),
  }),

}

const TOOL_SPECS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '使用搜索引擎查询互联网最新信息。返回 title、url、snippet 列表。当用户问到时事、最新发布、需要外部资料时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词,使用用户问题中的核心实体' },
          max_results: { type: 'integer', description: '返回结果上限,默认 6,最大 10', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
  },
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取指定 URL 的页面正文,返回 markdown 形式的主要内容。用于读取 web_search 给出的链接细节。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 http/https URL' },
        },
        required: ['url'],
      },
    },
  },

}

export function buildToolSpecs(enabledNames) {
  // 接受 Array / Set / 任何 iterable;去重防同一 spec 被塞进两遍
  // (#18 用户在权限中心可能勾选过 + toolsConfig 也开了重复来源)
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
      console.warn(`[tools] 未知工具被忽略: ${name}`)
    }
  }
  return list
}

export function listToolNames() {
  return Object.keys(TOOL_SPECS)
}

/* ── 执行器 ── */

async function callJson(url, body) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const err = new Error(data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return data
}

async function execWebSearch(args) {
  const query = String(args?.query || '').trim()
  if (!query) throw new Error('query 不能为空')
  const max_results = Number(args?.max_results) || 6
  const data = await callJson('/api/tools/search', { query, maxResults: max_results })
  // 返给模型的内容尽量精简
  return {
    content: JSON.stringify({
      query,
      results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    }),
    billing: data.billing || null,
  }
}

async function execFetchUrl(args) {
  const url = String(args?.url || '').trim()
  if (!url) throw new Error('url 不能为空')
  const data = await callJson('/api/tools/fetch', { url })
  return {
    content: JSON.stringify({
      url: data.url || url,
      title: data.title || '',
      truncated: !!data.truncated,
      markdown: data.markdown || '',
    }),
    billing: data.billing || null,
  }
}

const EXECUTORS = {
  web_search: execWebSearch,
  fetch_url: execFetchUrl,
}

export async function executeToolCall(call, options = {}) {
  const { maxRetries = 2, retryDelayMs = 600 } = options
  const name = call?.name
  const fn = EXECUTORS[name]
  let parsedArgs = {}
  if (call?.arguments) {
    try { parsedArgs = JSON.parse(call.arguments) } catch { parsedArgs = {} }
  }
  if (!fn) {
    return { ok: false, content: JSON.stringify({ error: `未知工具: ${name}` }) }
  }

  // ★ #18: zod 参数校验 — 失败直接返回 (不可重试)
  const schema = TOOL_ARG_SCHEMAS[name]
  if (schema) {
    const parsed = schema.safeParse(parsedArgs)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join('; ')
      return { ok: false, content: JSON.stringify({ error: `参数无效: ${issues}` }) }
    }
    parsedArgs = parsed.data
  }

  // ★ #24: 失败重试 — 网络/反爬瞬时错误自动重试 (最多 maxRetries 次,指数退避)
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await fn(parsedArgs)
      const content = typeof output === 'string' ? output : output.content
      const billing = typeof output === 'string' ? null : output.billing
      return { ok: true, content, billing, attempts: attempt + 1 }
    } catch (err) {
      lastErr = err
      const msg = err?.message || String(err)
      // 不可重试:参数校验类错误 (含「参数」「不能为空」等关键字)
      const nonRetriable = /参数|不能为空|invalid|required/i.test(msg)
      if (nonRetriable || attempt === maxRetries) break
      // 指数退避:600ms → 1200ms
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)))
    }
  }
  return {
    ok: false,
    content: JSON.stringify({
      error: lastErr?.message || String(lastErr),
      attempts: maxRetries + 1,
    }),
  }
}

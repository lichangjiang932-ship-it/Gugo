/**
 * 前端工具规格(OpenAI tool schema)和本地执行器(把 tool_call 路由到对应 fetch)。
 *
 * 流程:
 *   1) 前端把 buildToolSpecs(enabled) 塞进 chat 请求的 `tools` 字段
 *   2) 后端透传给上游模型,模型返回 tool_calls
 *   3) 前端 executeToolCall(call) 调本地 /api/tools/* 拿结果
 *   4) 把 { role: 'tool', tool_call_id, content } 追加到 messages,再发一轮
 */

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
  run_js: {
    type: 'function',
    function: {
      name: 'run_js',
      description: '在浏览器隔离 Worker 中执行一段纯 JavaScript(无 DOM/fetch),用于数学、字符串、JSON 处理。返回 stdout(console.log 内容)与最后一个表达式的值。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 JavaScript 代码,可以含 console.log。最长 8000 字符。' },
        },
        required: ['code'],
      },
    },
  },
}

export function buildToolSpecs(enabledNames) {
  const list = []
  for (const name of enabledNames) {
    if (TOOL_SPECS[name]) list.push(TOOL_SPECS[name])
  }
  return list
}

export function listToolNames() {
  return Object.keys(TOOL_SPECS)
}

/* ── 执行器 ── */

async function callJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  return JSON.stringify({
    query,
    results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
  })
}

async function execFetchUrl(args) {
  const url = String(args?.url || '').trim()
  if (!url) throw new Error('url 不能为空')
  const data = await callJson('/api/tools/fetch', { url })
  return JSON.stringify({
    url: data.url || url,
    title: data.title || '',
    truncated: !!data.truncated,
    markdown: data.markdown || '',
  })
}

async function execRunJs(args) {
  const code = String(args?.code || '')
  if (!code.trim()) throw new Error('code 不能为空')
  if (code.length > 8000) throw new Error('代码过长(>8000 字符)')
  // 用 Worker 跑,5 秒超时
  return await new Promise((resolve, reject) => {
    const src = `
      const __logs = [];
      const console = { log: (...a) => __logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) };
      self.onmessage = async (e) => {
        try {
          const fn = new Function('console', 'return (async () => { ' + e.data + ' })()');
          const value = await fn(console);
          self.postMessage({ ok: true, stdout: __logs.join('\\n'), value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
        } catch (err) {
          self.postMessage({ ok: false, error: String(err && err.message || err) });
        }
      };
    `
    const blob = new Blob([src], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    const timer = setTimeout(() => {
      worker.terminate()
      URL.revokeObjectURL(url)
      reject(new Error('运行超时(>5s)'))
    }, 5000)
    worker.onmessage = (ev) => {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      const data = ev.data
      if (!data?.ok) return reject(new Error(data?.error || '执行失败'))
      resolve(JSON.stringify({ stdout: data.stdout, value: data.value }))
    }
    worker.onerror = (err) => {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      reject(new Error(err.message || 'Worker 错误'))
    }
    worker.postMessage(code)
  })
}

const EXECUTORS = {
  web_search: execWebSearch,
  fetch_url: execFetchUrl,
  run_js: execRunJs,
}

export async function executeToolCall(call) {
  const name = call?.name
  const fn = EXECUTORS[name]
  let parsedArgs = {}
  if (call?.arguments) {
    try { parsedArgs = JSON.parse(call.arguments) } catch { parsedArgs = {} }
  }
  if (!fn) {
    return { ok: false, content: JSON.stringify({ error: `未知工具: ${name}` }) }
  }
  try {
    const content = await fn(parsedArgs)
    return { ok: true, content }
  } catch (err) {
    return { ok: false, content: JSON.stringify({ error: err?.message || String(err) }) }
  }
}

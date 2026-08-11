/**
 * \u524d\u7aef\u5de5\u5177\u76ee\u5f55\u548c\u672c\u5730\u7aef\u70b9\u5ba2\u6237\u7aef\u3002
 *
 * \u804a\u5929\u5de5\u5177\u5faa\u73af\u7531\u670d\u52a1\u7aef turn engine \u8d1f\u8d23\uff1b\u8fd9\u91cc\u7684\u89c4\u683c\u7528\u4e8e\u4e0a\u4e0b\u6587\u9762\u677f\u5c55\u793a\uff0c
 * executeToolCall \u4ecd\u7528\u4e8e\u53d1\u9001\u524d\u7684\u672c\u5730\u8def\u5f84\u6388\u6743\u63a2\u6d4b\u53ca\u72ec\u7acb\u5de5\u5177\u5ba2\u6237\u7aef\u3002
 */

// \u2605 batchF P1: /api/tools/* \u73b0\u5728\u5f3a\u5236\u9274\u6743,\u524d\u7aef\u5fc5\u987b\u5e26 token,
//   \u5426\u5219\u672a\u767b\u5f55\u7528\u6237\u80fd\u76f4\u63a5\u8c03\u7528\u641c\u7d22/\u6293\u53d6\u5e76\u6d88\u8017\u540e\u7aef\u8d44\u6e90\u3002
// \u2605 batchG: \u6587\u4ef6\u751f\u6210\u5de5\u5177\u7528\u5230\u7684\u89e3\u6790\u5668 \u2014 \u65e7\u7248\u52a8\u6001 import \u4f1a\u89e6\u53d1 vite
//   INEFFECTIVE_DYNAMIC_IMPORT \u8b66\u544a(\u56e0\u4e3a\u540c\u6a21\u5757\u8fd8\u88ab artifactPreview.js /
//   RightPreviewPane.jsx \u9759\u6001 import),\u6240\u4ee5\u8fd9\u91cc\u76f4\u63a5\u9759\u6001\u5f15\u5165,\u53cd\u6b63
//   ChatSplit chunk \u91cc\u672c\u5c31\u5305\u542b\u8fd9\u4e24\u4e2a\u6a21\u5757.
import { askDirectoryApproval } from '../toolApproval.js'
import { translateKey } from '../../i18n/translations.js'

const FILE_ARTIFACT_TOOL_NAMES = new Set(['create_pptx', 'create_docx', 'create_xlsx', 'create_html_app'])

// \u2605 #18: \u5de5\u5177\u53c2\u6570 zod schema \u2014 \u6a21\u578b\u53ef\u80fd\u7ed9\u51fa\u810f\u6570\u636e,\u5148\u6821\u9a8c\u518d\u6267\u884c
import { EXECUTORS } from './builtinExecutors.js'
import { callJson } from './toolHttpClient.js'
import { TOOL_ARG_SCHEMAS } from './toolArgSchemas.js'
import { TOOL_SPECS } from './toolSpecs.js'
export { buildToolSpecs, listToolNames, resolveToolsForMode } from './toolSpecs.js'

export function getStandaloneToolClientStatus() {
  const specNames = Object.keys(TOOL_SPECS)
  const executorNames = Object.keys(EXECUTORS)
  return {
    scope: 'standalone_client',
    missingExecutors: specNames.filter((name) => typeof EXECUTORS[name] !== 'function'),
    missingSpecs: executorNames.filter((name) => !TOOL_SPECS[name]),
  }
}

/** @deprecated Chat turns use the server TurnEngine. Use getStandaloneToolClientStatus(). */
export function getBuiltinToolRuntimeStatus() {
  const status = getStandaloneToolClientStatus()
  return {
    missingExecutors: status.missingExecutors,
    missingSpecs: status.missingSpecs,
  }
}

/**
 * multi_edit \u2014 \u539f\u5b50\u5316\u6279\u91cf SEARCH/REPLACE\u3002
 *
 * \u6d41\u7a0b\uff1a
 *   1. \u8bfb\u53d6\u6240\u6709\u76ee\u6807\u6587\u4ef6\u7684\u5185\u5bb9\uff08\u8bfb\u4e00\u6b21\uff09
 *   2. \u6821\u9a8c\u6bcf\u4e2a oldText \u5728\u6587\u4ef6\u4e2d\u552f\u4e00\u5b58\u5728
 *   3. \u5168\u90e8\u901a\u8fc7 \u2192 \u5bf9\u6240\u6709\u6587\u4ef6\u505a\u66ff\u6362\u5e76\u5199\u56de
 *   4. \u4efb\u4f55\u4e00\u4e2a\u5199\u5165\u5931\u8d25 \u2192 \u56de\u6eda\u5df2\u5199\u7684\u6587\u4ef6\u5230\u539f\u59cb\u5185\u5bb9
 */
/** @deprecated Compatibility client for standalone previews/tests; chat execution is server-owned. */
export async function executeToolCall(call, options = {}) {  const { maxRetries = 2, retryDelayMs = 600 } = options
  const name = call?.name
  if (FILE_ARTIFACT_TOOL_NAMES.has(name)) {
    const granted = options.allowedArtifactTools instanceof Set
      ? options.allowedArtifactTools
      : new Set(options.allowedArtifactTools || [])
    if (!granted.has(name)) {
      return {
        ok: false,
        content: JSON.stringify({
          code: 'artifact_tool_not_requested',
          error: String(translateKey('toolRuntime.artifactNotRequested', options.lang || 'zh')).replace('{name}', name),
          retryable: false,
        }),
        attempts: 0,
      }
    }
  }
  let parsedArgs = {}
  if (call?.arguments) {
    try {
      parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        throw new Error('\u53c2\u6570 JSON \u7684\u9876\u5c42\u5fc5\u987b\u662f\u5bf9\u8c61')
      }
    } catch (err) {
      return {
        ok: false,
        content: JSON.stringify({
          code: 'invalid_tool_arguments',
          error: `\u5de5\u5177\u53c2\u6570\u4e0d\u662f\u6709\u6548 JSON\uff1a${err?.message || String(err)}`,
          retryable: true,
          hint: '\u8bf7\u4fee\u6b63 JSON \u540e\u91cd\u65b0\u8c03\u7528\uff0c\u4e0d\u8981\u91cd\u590d\u53d1\u9001\u76f8\u540c\u53c2\u6570\u3002',
        }),
        attempts: 0,
      }
    }
  }

  // Feature 1: MCP \u5de5\u5177 (mcp__server__tool) \u2014 \u6ca1\u5728\u672c\u5730 EXECUTORS \u6ce8\u518c,\u7edf\u4e00\u8d70\u540e\u7aef
  if (name && name.startsWith('mcp__')) {
    try {
      const data = await callJson('/api/tools/mcp/call', { fullToolName: name, arguments: parsedArgs })
      // MCP tools/call \u8fd4\u56de { content: [{type, text/...}], isError? }
      const result = data?.result || data
      const isError = !!result?.isError
      const textParts = Array.isArray(result?.content)
        ? result.content
            .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
            .map((c) => c.text || '')
            .join('\n')
        : JSON.stringify(result)
      return {
        ok: !isError,
        content: textParts || JSON.stringify(result),
        attempts: 1,
      }
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: err.message || String(err) }) }
    }
  }

  if (name && name.startsWith('browser_')) {
    const routes = {
      browser_open_url: '/api/browser/open',
      browser_state: '/api/browser/state',
      browser_snapshot: '/api/browser/snapshot',
      browser_console: '/api/browser/console',
      browser_click: '/api/browser/click',
      browser_type: '/api/browser/type',
      browser_wait: '/api/browser/wait',
      browser_screenshot: '/api/browser/screenshot',
    }
    const route = routes[name]
    if (!route) return { ok: false, content: JSON.stringify({ error: `\u672a\u77e5 Browser \u5de5\u5177: ${name}` }) }
    try {
      const data = await callJson(route, parsedArgs)
      const result = data?.result ?? data
      const compact = name === 'browser_screenshot' && result?.data
        ? { ...result, data: undefined, captured: true }
        : result
      return { ok: true, content: JSON.stringify(compact), attempts: 1 }
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: err.message || String(err) }), attempts: 1 }
    }
  }

  if (name && (name.startsWith('connected_app_') || name.startsWith('notion_') || name.startsWith('github_'))) {
    const routes = {
      connected_app_list: '/api/connectors/apps',
      connected_app_open: '/api/connectors/apps/open',
      notion_search: '/api/connectors/notion/search',
      notion_fetch_page: '/api/connectors/notion/page',
      github_search_repositories: '/api/connectors/github/search-repositories',
      github_get_file: '/api/connectors/github/file',
    }
    const route = routes[name]
    if (!route) return { ok: false, content: JSON.stringify({ error: `Unknown connector tool: ${name}` }) }
    try {
      const data = name === 'connected_app_list'
        ? await callJson(route, undefined, { method: 'GET' })
        : await callJson(route, parsedArgs)
      return { ok: true, content: JSON.stringify(data?.result ?? data?.apps ?? data), attempts: 1 }
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: err.message || String(err) }), attempts: 1 }
    }
  }

  const fn = EXECUTORS[name]
  if (!fn) {
    return { ok: false, content: JSON.stringify({ error: `\u672a\u77e5\u5de5\u5177: ${name}` }) }
  }

  // \u2605 #18: zod \u53c2\u6570\u6821\u9a8c \u2014 \u5931\u8d25\u76f4\u63a5\u8fd4\u56de (\u4e0d\u53ef\u91cd\u8bd5)
  const schema = TOOL_ARG_SCHEMAS[name]
  if (schema) {
    const parsed = schema.safeParse(parsedArgs)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join('; ')
      return { ok: false, content: JSON.stringify({ error: `\u53c2\u6570\u65e0\u6548: ${issues}` }) }
    }
    parsedArgs = parsed.data
  }

  // \u2605 #24: \u5931\u8d25\u91cd\u8bd5 \u2014 \u7f51\u7edc/\u53cd\u722c\u77ac\u65f6\u9519\u8bef\u81ea\u52a8\u91cd\u8bd5 (\u6700\u591a maxRetries \u6b21,\u6307\u6570\u9000\u907f)
  let lastErr
  let usedAttempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    usedAttempts = attempt + 1
    try {
      const output = await fn(parsedArgs)
      const ok = output && typeof output === 'object' && typeof output.ok === 'boolean' ? output.ok : true
      const content = typeof output === 'string' ? output : output.content
      const artifact = typeof output === 'string' ? null : (output.artifact || null)
      // Feature 8: manage_todos \u8fd4\u56de\u7684 todos \u5b57\u6bb5\u76f4\u4f20 caller,\u7528\u4e8e dispatch SET_TODOS
      const todos = typeof output === 'string' ? null : (output.todos || null)
      return { ok, content, artifact, todos, attempts: attempt + 1 }
    } catch (err) {
      lastErr = err
      if (err?.code === 'PATH_NOT_AUTHORIZED') {
        const decision = await askDirectoryApproval({
          name,
          args: parsedArgs,
          path: err.path || parsedArgs?.path || null,
          suggestGrantPath: err.suggestGrantPath || err.path || parsedArgs?.path || null,
          requiredAccessMode: err.requiredAccessMode
            || (['write_file', 'edit_file', 'apply_patch'].includes(name) ? 'read_write' : 'read_only'),
        })
        if (!decision.approved) {
          const denied = new Error(decision.reason || 'The user denied directory authorization.')
          denied.code = 'PATH_AUTHORIZATION_REJECTED'
          denied.status = 403
          denied.retryable = false
          denied.path = err.path
          lastErr = denied
          break
        }

        // The grant UI resolves only after persistence. Retry this exact
        // operation once; a second failure is final and must not reopen the
        // authorization prompt or enter the generic retry loop.
        usedAttempts += 1
        try {
          const output = await fn(parsedArgs)
          const ok = output && typeof output === 'object' && typeof output.ok === 'boolean' ? output.ok : true
          const content = typeof output === 'string' ? output : output.content
          const artifact = typeof output === 'string' ? null : (output.artifact || null)
          const todos = typeof output === 'string' ? null : (output.todos || null)
          return { ok, content, artifact, todos, attempts: usedAttempts }
        } catch (retryError) {
          lastErr = retryError
          break
        }
      }
      const msg = err?.message || String(err)
      // \u4e0d\u53ef\u91cd\u8bd5:\u53c2\u6570\u6821\u9a8c\u7c7b\u9519\u8bef / \u6c99\u7bb1\u7b56\u7565\u62d2\u7edd
      let nonRetriable = /\u53c2\u6570|\u4e0d\u80fd\u4e3a\u7a7a|invalid|required|\u6c99\u7bb1/i.test(msg)
      // \u2605 404(\u8def\u7531\u4e0d\u5b58\u5728)/ 403(\u6743\u9650\u4e0d\u8db3)/ 401 \u91cd\u8bd5\u6beb\u65e0\u610f\u4e49 \u2014\u2014 \u8fd9\u4e9b\u662f
      // \u786e\u5b9a\u6027\u5931\u8d25,\u9000\u907f\u518d\u6253\u4e09\u6b21\u53ea\u662f\u628a\u4e00\u6b21\u5931\u8d25\u53d8\u6210\u4e09\u6b21\u5931\u8d25 + \u4e24\u6b21\u7b49\u5f85\u3002
      // \u5b9e\u6d4b\u65e5\u5fd7\u91cc grep_code \u56e0\u4e3a\u540e\u7aef\u6f0f\u6ce8\u518c\u8def\u7531,\u6bcf\u6b21\u8c03\u7528\u90fd\u767d\u7b49\u4e24\u8f6e\u9000\u907f,
      // \u6a21\u578b\u8fde\u8bd5 6 \u6b21\u5171 18 \u4e2a\u8bf7\u6c42\u5168 404,\u9884\u7b97\u548c\u65f6\u95f4\u90fd\u70e7\u5728\u4e86\u539f\u5730\u6253\u8f6c\u4e0a\u3002
      if (err?.status === 404 || err?.status === 403 || err?.status === 401) {
        nonRetriable = true
      }
      if (nonRetriable || attempt === maxRetries) break
      // \u6307\u6570\u9000\u907f:600ms \u2192 1200ms
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)))
    }
  }
  return {
    ok: false,
    content: JSON.stringify({
      ...(lastErr?.code ? { code: lastErr.code } : {}),
      error: lastErr?.message || String(lastErr),
      // \u771f\u5b9e\u5c1d\u8bd5\u6b21\u6570 \u2014\u2014 \u786e\u5b9a\u6027\u5931\u8d25\u4f1a\u63d0\u524d break,\u4e0d\u8be5\u8c0e\u62a5\u6210 maxRetries + 1
      attempts: usedAttempts,
      // \u786e\u5b9a\u6027\u5931\u8d25\u8981\u660e\u786e\u544a\u8bc9\u6a21\u578b\u522b\u518d\u8bd5\u540c\u4e00\u4e2a\u5de5\u5177
      ...(lastErr?.retryable === false || lastErr?.status === 404 || lastErr?.status === 403 || lastErr?.status === 401
        ? { retryable: false, hint: lastErr?.hint || '\u8fd9\u662f\u786e\u5b9a\u6027\u5931\u8d25\uff0c\u91cd\u8bd5\u6216\u6362\u53c2\u6570\u90fd\u6ca1\u7528\uff0c\u8bf7\u6539\u7528\u5176\u4ed6\u5de5\u5177\u3002' }
        : {}),
      ...(lastErr?.path ? { path: lastErr.path } : {}),
    }),
  }
}

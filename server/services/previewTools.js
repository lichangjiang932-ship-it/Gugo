import { startPreviewServer, stopPreviewServer, waitForPreviewServer } from './previewServerStore.js'
import { requestPageFacts } from './previewPageFacts.js'

/**
 * The tools the agent verifies its own work with.
 *
 * They are the dev server and the panel the reader already has, exposed to the
 * model: start the project, look at it, read what it logged, and act on it. The
 * page facts travel through the window that owns the docked view (see
 * previewPageFacts), so what the agent reads is the page the reader is looking at.
 *
 * Every tool answers with the same shape — { success, output, error } — because a
 * model deciding what to do next should not have to learn a different envelope
 * per tool. A page that has no such element is `success: false` with a reason, not
 * a failed call: that answer is the point of asking.
 */

const definitions = [
  ['preview_start_server',
    'Start the development server this project declares in .gugo/launch.json and wait until it serves. Reuses the running server when it is already up.',
    { configName: { type: 'string', maxLength: 120 } },
    []],
  ['preview_stop_server',
    'Stop the project development server and its child processes.',
    {}, []],
  ['preview_screenshot',
    'Capture what the preview panel is showing, as an image you can look at.',
    {}, []],
  ['preview_inspect_dom',
    'Read the preview page: title, visible text, headings, buttons, inputs and links, with their boxes. Pass a selector to read one element instead.',
    { selector: { type: 'string', maxLength: 400 } },
    []],
  ['preview_get_console_logs',
    'Read the console messages the preview page produced since the last read, including errors and warnings.',
    {}, []],
  ['preview_click',
    'Click an element in the preview page by CSS selector.',
    { selector: { type: 'string', minLength: 1, maxLength: 400 } },
    ['selector']],
  ['preview_type',
    'Type into an input or textarea in the preview page by CSS selector.',
    { selector: { type: 'string', minLength: 1, maxLength: 400 }, text: { type: 'string', maxLength: 4_000 } },
    ['selector', 'text']],
  ['preview_navigate',
    'Open a URL in the preview panel. Addresses on this machine open directly; an address elsewhere on the internet opens only after the reader approves it once.',
    { url: { type: 'string', maxLength: 2_048 } },
    ['url']],
]

/**
 * The model-facing schemas.
 *
 * Static, like the other core loop tools: the preview belongs to the project the
 * conversation is already in, not to an integration that is switched on, so it
 * needs no separate visibility gate of its own.
 */
export const PREVIEW_TOOL_SPECS = definitions.map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}))

function verdict({ success, output = '', error = '', ...rest }) {
  return { ok: true, success, output, error, ...rest }
}

function describeServer(state) {
  if (!state || state.status === 'stopped') return 'preview server: stopped'
  const parts = [`preview server: ${state.status}`, `name ${state.name}`, `port ${state.port}`, `url ${state.url}`]
  if (state.error) parts.push(`error ${state.error}`)
  return parts.join(', ')
}

async function runStartServer({ workspaceRoot, userId, args }) {
  const started = await startPreviewServer({ userId, workspaceRoot, name: String(args?.configName || '') })
  if (!started.ok) return verdict({ success: false, error: started.error })
  const ready = await waitForPreviewServer({ userId, workspaceRoot, timeoutMs: 30_000 })
  if (!ready.ok) {
    return verdict({ success: false, output: describeServer(ready), error: ready.error, log: ready.log || '' })
  }
  return verdict({
    success: true,
    output: `${describeServer(ready)}${started.reused ? ' (already running)' : ''}`,
    url: ready.url,
    port: ready.port,
  })
}

/** Collect the requested facts from the window, or explain why they did not come. */
async function collectPageFacts({ workspaceRoot, userId, ops, signal, requestFacts }) {
  const answer = await requestFacts({ userId, workspaceRoot, ops, signal })
  if (!answer.ok) return { ok: false, error: answer.error, code: answer.code }
  const results = answer.results || []
  const failures = (answer.errors || []).map((entry) => entry.message).filter(Boolean)
  return { ok: true, results, failures }
}

function firstResult(results, kind) {
  return results.find((entry) => entry?.kind === kind) || null
}

async function runScreenshot({ workspaceRoot, userId, signal, requestFacts }) {
  const facts = await collectPageFacts({ workspaceRoot, userId, ops: [{ kind: 'screenshot' }], signal, requestFacts })
  if (!facts.ok) return verdict({ success: false, error: facts.error })
  const shot = firstResult(facts.results, 'screenshot')
  if (!shot?.ok || typeof shot.dataUrl !== 'string') {
    return verdict({ success: false, error: shot?.message || '预览面板没有返回截图' })
  }
  const base64 = shot.dataUrl.split(',')[1] || ''
  return verdict({
    success: true,
    output: `screenshot ${shot.width}x${shot.height}`,
    image: { data: base64, mimeType: 'image/png' },
  })
}

/** The page's own answer, parsed out of the host's JSON string. */
function parseScriptResult(result) {
  if (typeof result !== 'string') return result ?? null
  try {
    return JSON.parse(result)
  } catch {
    return null
  }
}

async function runInspectDom({ workspaceRoot, userId, args, signal, requestFacts }) {
  const selector = typeof args?.selector === 'string' && args.selector.trim() ? args.selector.trim() : ''
  const facts = await collectPageFacts({
    workspaceRoot,
    userId,
    ops: [selector ? { kind: 'dom', selector } : { kind: 'dom' }],
    signal,
    requestFacts,
  })
  if (!facts.ok) return verdict({ success: false, error: facts.error })
  const dom = firstResult(facts.results, 'dom')
  if (!dom?.ok) return verdict({ success: false, error: dom?.message || '读取页面失败' })
  const parsed = parseScriptResult(dom.result)
  // "That selector matches nothing" is a real answer, and the model can only act
  // on it if it arrives as one.
  if (parsed?.found === false) {
    return verdict({ success: false, error: `页面里没有匹配 ${selector} 的元素` })
  }
  return verdict({ success: true, output: String(dom.result || '').slice(0, 16_000) })
}

async function runConsoleLogs({ workspaceRoot, userId, signal, requestFacts }) {
  const facts = await collectPageFacts({ workspaceRoot, userId, ops: [{ kind: 'console' }], signal, requestFacts })
  if (!facts.ok) return verdict({ success: false, error: facts.error })
  const entries = firstResult(facts.results, 'console')?.entries || []
  const errors = entries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  const lines = entries.map((entry) => `[${entry.level}] ${entry.message}`)
  return verdict({
    success: true,
    output: lines.length ? lines.join('\n').slice(0, 16_000) : 'no console output since the last read',
    errors: errors.length,
    count: entries.length,
  })
}

async function runPageAction({ workspaceRoot, userId, ops, kind, signal, requestFacts }) {
  const facts = await collectPageFacts({ workspaceRoot, userId, ops, signal, requestFacts })
  if (!facts.ok) return verdict({ success: false, error: facts.error })
  const step = firstResult(facts.results, kind)
  if (!step?.ok) return verdict({ success: false, error: step?.message || step?.reason || `${kind} 未执行` })
  const outcome = parseScriptResult(step.result)
  // The page reports what happened; a selector that matched nothing is a failure
  // of the action, not of the call.
  if (outcome?.ok === false) {
    const reason = outcome.reason === 'not-found'
      ? `页面里没有匹配 ${outcome.selector || '该选择器'} 的元素`
      : (outcome.reason || `${kind} 未执行`)
    return verdict({ success: false, error: reason })
  }
  return verdict({ success: true, output: typeof step.result === 'string' ? step.result.slice(0, 4_000) : JSON.stringify(step.result ?? null) })
}

/**
 * A preview address, as an http(s) URL or nothing.
 *
 * Whether it may leave this machine is not decided here: that is the approval
 * policy's question (see explicitConfirmationReason), which asks the reader once
 * for an outside address and remembers the answer. This only refuses what no
 * browser should be pointed at — anything that is not http(s).
 */
function previewUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim())
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}

/**
 * One preview tool call.
 *
 * `workspaceRoot` is the project the conversation is in; the page-fact tools need
 * it to know which panel is being asked, and the server tools need it to know
 * which launch.json to read.
 */
export async function executePreviewTool(name, args = {}, {
  userId = null, workspaceRoot = '', signal = null, requestFacts = requestPageFacts,
} = {}) {
  if (!workspaceRoot) {
    return verdict({ success: false, error: '这次对话还没有绑定项目目录，预览不知道要看哪个工程' })
  }
  if (name === 'preview_start_server') return runStartServer({ workspaceRoot, userId, args })
  if (name === 'preview_stop_server') {
    const stopped = await stopPreviewServer({ userId, workspaceRoot })
    return verdict({ success: true, output: stopped.stopped ? 'preview server stopped' : 'preview server was not running' })
  }
  if (name === 'preview_screenshot') return runScreenshot({ workspaceRoot, userId, signal, requestFacts })
  if (name === 'preview_inspect_dom') return runInspectDom({ workspaceRoot, userId, args, signal, requestFacts })
  if (name === 'preview_get_console_logs') return runConsoleLogs({ workspaceRoot, userId, signal, requestFacts })
  if (name === 'preview_click') {
    return runPageAction({ workspaceRoot, userId, kind: 'click', ops: [{ kind: 'click', selector: String(args.selector || '') }], signal, requestFacts })
  }
  if (name === 'preview_type') {
    return runPageAction({
      workspaceRoot,
      userId,
      kind: 'type',
      ops: [{ kind: 'type', selector: String(args.selector || ''), text: String(args.text ?? '') }],
      signal,
      requestFacts,
    })
  }
  if (name === 'preview_navigate') {
    const url = previewUrl(args.url)
    if (!url) return verdict({ success: false, error: '预览只接受 http(s) 地址' })
    return runPageAction({ workspaceRoot, userId, kind: 'navigate', ops: [{ kind: 'navigate', url }], signal, requestFacts })
  }
  throw new Error(`Unknown preview tool: ${name}`)
}

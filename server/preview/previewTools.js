import { previewRuntime } from './previewRuntime.js'

/**
 * The preview tools the agent *may* call.
 *
 * There is no verification phase and no iteration cap: the loop never invokes
 * these on its own, exactly as Claude Code and Pi treat inspection tooling. If
 * the model wants to see the page, it starts the server and looks; if it does
 * not, nothing happens.
 *
 * Server-side controls (start/stop/logs) run here. Anything that needs the
 * rendered page (screenshot, DOM, console, click, type, navigate) must go
 * through the desktop host bridge, which the renderer owns; without that host
 * the tool answers `PREVIEW_HOST_UNAVAILABLE` instead of pretending.
 */
export const PREVIEW_TOOL_SPECS = Object.freeze([
  {
    name: 'preview_start_server',
    description: 'Start the preview dev server declared in .gugo/launch.json (optional configName). Returns its URL and readiness.',
    parameters: { type: 'object', properties: { configName: { type: 'string' } }, required: [] },
  },
  {
    name: 'preview_stop_server',
    description: 'Stop the preview dev server started by this session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'preview_server_status',
    description: 'Report the preview dev server status, URL and the last log lines.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'preview_screenshot',
    description: 'Screenshot the preview page as base64 PNG. Requires the desktop preview host.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'preview_inspect_dom',
    description: 'Return the DOM summary of the preview page, or of one selector. Requires the desktop preview host.',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: [] },
  },
  {
    name: 'preview_get_console_logs',
    description: 'Return console errors/warnings from the preview page plus the dev server output. Requires the desktop preview host for browser logs.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'preview_navigate',
    description: 'Navigate the preview page to a URL. Requires the desktop preview host.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'preview_click',
    description: 'Click an element in the preview page. Requires the desktop preview host.',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  },
  {
    name: 'preview_type',
    description: 'Type text into an element in the preview page. Requires the desktop preview host.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
  },
])

export const PREVIEW_TOOL_NAMES = Object.freeze(PREVIEW_TOOL_SPECS.map((spec) => spec.name))

function unavailable() {
  return { success: false, output: '', error: 'PREVIEW_HOST_UNAVAILABLE' }
}

function ok(output) {
  return { success: true, output: typeof output === 'string' ? output : JSON.stringify(output), error: '' }
}

function failure(error) {
  return { success: false, output: '', error: String(error || 'PREVIEW_TOOL_FAILED') }
}

/** `host` is the renderer's bridge; without it every page-facing tool says so. */
export async function executePreviewTool(name, args = {}, { runtime = previewRuntime, host = null } = {}) {
  if (!PREVIEW_TOOL_NAMES.includes(name)) return failure('PREVIEW_TOOL_UNKNOWN')
  try {
    switch (name) {
      case 'preview_start_server': {
        const result = await runtime.start({ workspacePath: args.workspacePath, name: args.configName })
        return result.ok
          ? ok({ url: result.url, port: result.port, name: result.name, ready: result.ready === true, autoVerify: result.autoVerify })
          : failure(result.code || result.message)
      }
      case 'preview_stop_server':
        return ok(runtime.stop())
      case 'preview_server_status': {
        const status = runtime.publicState()
        return ok({ ...status, logs: runtime.tail(20).map((entry) => entry.line) })
      }
      case 'preview_get_console_logs': {
        const serverLogs = runtime.tail(50).map((entry) => ({ source: `server.${entry.channel}`, line: entry.line }))
        const browserLogs = host?.consoleLogs ? await host.consoleLogs() : null
        if (!host?.consoleLogs) return ok({ server: serverLogs, browser: null, note: 'browser console needs the desktop preview host' })
        return ok({ server: serverLogs, browser: browserLogs })
      }
      case 'preview_screenshot': {
        if (!host?.screenshot) return unavailable()
        const png = await host.screenshot()
        return png ? ok({ base64: png }) : failure('PREVIEW_SCREENSHOT_EMPTY')
      }
      case 'preview_inspect_dom': {
        if (!host?.inspectDom) return unavailable()
        return ok(await host.inspectDom(args.selector || ''))
      }
      case 'preview_navigate': {
        if (!host?.navigate) return unavailable()
        if (!String(args.url || '').trim()) return failure('PREVIEW_URL_REQUIRED')
        return ok(await host.navigate(args.url))
      }
      case 'preview_click': {
        if (!host?.click) return unavailable()
        if (!String(args.selector || '').trim()) return failure('PREVIEW_SELECTOR_REQUIRED')
        return ok(await host.click(args.selector))
      }
      case 'preview_type': {
        if (!host?.type) return unavailable()
        if (!String(args.selector || '').trim()) return failure('PREVIEW_SELECTOR_REQUIRED')
        return ok(await host.type(args.selector, String(args.text ?? '')))
      }
      default:
        return failure('PREVIEW_TOOL_UNKNOWN')
    }
  } catch (error) {
    return failure(error?.code || error?.message || error)
  }
}

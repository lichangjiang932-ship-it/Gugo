import { listAllSpecs, registerDynamicTool, unregisterByOrigin } from './toolRegistry.js'

const definitions = [
  ['browser_open_url', 'Open or navigate to an http/https URL in the isolated local browser. browser_navigate is the standard-name alias.', { url: { type: 'string' } }, ['url']],
  ['browser_navigate', 'Navigate the isolated local browser to an http/https URL. Use browser_snapshot after navigation to obtain fresh element refs.', { url: { type: 'string' } }, ['url']],
  ['browser_state', 'Read the current browser URL, title and connection state.', {}, []],
  ['browser_tabs', 'List up to 50 open page tabs and popups in the current isolated browser session. Connected-app tabs that are not authorized are redacted.', {}, []],
  ['browser_switch_tab', 'Switch the active automation context to an open tab or popup by targetId from browser_tabs. Take a fresh snapshot after switching.', { targetId: { type: 'string', minLength: 1, maxLength: 512 } }, ['targetId']],
  ['browser_frames', 'List up to 100 frames in the active tab, including cross-origin frames. Connected-app frames without current user authorization are redacted. Use browser_switch_frame before interacting with a child frame.', {}, []],
  ['browser_switch_frame', 'Switch DOM automation to a frameId from browser_frames. The host revalidates the frame URL and connected-app ownership before creating an isolated CDP execution context. Switch to the main frame to leave a child frame.', { frameId: { type: 'string', minLength: 1, maxLength: 512 } }, ['frameId']],
  ['browser_snapshot',  'Read the current page text and interactive elements. Use returned refs for click/type/select/press, and take a fresh snapshot after navigation or major DOM changes.', { maxText: { type: 'integer', minimum: 1000, maximum: 50000 } }, []],
  ['browser_console', 'Read page console messages and uncaught exceptions.', { clear: { type: 'boolean' } }, []],
  ['browser_click', 'Click an element by snapshot ref (for example e3) or CSS selector.', { target: { type: 'string' } }, ['target']],
  ['browser_type', 'Fill an input by snapshot ref or CSS selector.', { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['target', 'text']],
  ['browser_upload_file', 'Attach one authorized local file to an <input type="file"> by snapshot ref or CSS selector. This may trigger page upload handlers and requires approval.', { target: { type: 'string' }, path: { type: 'string' } }, ['target', 'path']],
  ['browser_download', 'Click a download element and publish exactly one completed browser download to an authorized local path. Partial, oversized, multiple, timed-out, and unsafe files fail closed.', { target: { type: 'string' }, path: { type: 'string' }, overwrite: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 }, max_bytes: { type: 'integer', minimum: 1, maximum: 524288000 } }, ['target', 'path']],
  ['browser_select', 'Select an option in a <select> by snapshot ref or CSS selector. Match the option by value or visible label.', { target: { type: 'string' }, value: { type: 'string' } }, ['target', 'value']],
  ['browser_press', 'Press a keyboard key on an element or the currently focused page. Examples: Enter, Tab, Escape, ArrowDown.', { target: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 64 } }, ['key']],
  ['browser_wait', 'Wait for milliseconds or for an element to appear.', { ms: { type: 'integer', minimum: 0, maximum: 10000 }, target: { type: 'string' } }, []],
  ['browser_screenshot', 'Capture the current page as PNG.', { fullPage: { type: 'boolean' } }, []],
]

const MUTATING_TOOLS = new Set([
  'browser_open_url',
  'browser_navigate',
  'browser_switch_tab',
  'browser_switch_frame',
  'browser_click',
  'browser_type',
  'browser_upload_file',
  'browser_download',
  'browser_select',
  'browser_press',
])

export function registerBrowserTools() {
  unregisterByOrigin('browser')
  for (const [name, description, properties, required] of definitions) {
    registerDynamicTool({
      name,
      origin: 'browser',
      source: 'local',
      metadata: { riskClass: MUTATING_TOOLS.has(name) ? 'external' : 'read' },
      spec: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    })
  }
}

export function listRegisteredBrowserToolSpecs() {
  return listAllSpecs()
    .filter((entry) => entry.origin === 'browser')
    .map((entry) => entry.tool)
}

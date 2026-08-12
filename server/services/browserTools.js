import { listAllSpecs, registerDynamicTool, unregisterByOrigin } from './toolRegistry.js'

const definitions = [
  ['browser_open_url', 'Open or navigate to an http/https URL in the isolated local browser. browser_navigate is the standard-name alias.', { url: { type: 'string' } }, ['url']],
  ['browser_navigate', 'Navigate the isolated local browser to an http/https URL. Use browser_snapshot after navigation to obtain fresh element refs.', { url: { type: 'string' } }, ['url']],
  ['browser_state', 'Read the current browser URL, title and connection state.', {}, []],
  ['browser_snapshot', 'Read the current page text and interactive elements. Use returned refs for click/type/select/press, and take a fresh snapshot after navigation or major DOM changes.', { maxText: { type: 'integer', minimum: 1000, maximum: 50000 } }, []],
  ['browser_console', 'Read page console messages and uncaught exceptions.', { clear: { type: 'boolean' } }, []],
  ['browser_click', 'Click an element by snapshot ref (for example e3) or CSS selector.', { target: { type: 'string' } }, ['target']],
  ['browser_type', 'Fill an input by snapshot ref or CSS selector.', { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['target', 'text']],
  ['browser_select', 'Select an option in a <select> by snapshot ref or CSS selector. Match the option by value or visible label.', { target: { type: 'string' }, value: { type: 'string' } }, ['target', 'value']],
  ['browser_press', 'Press a keyboard key on an element or the currently focused page. Examples: Enter, Tab, Escape, ArrowDown.', { target: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 64 } }, ['key']],
  ['browser_wait', 'Wait for milliseconds or for an element to appear.', { ms: { type: 'integer', minimum: 0, maximum: 10000 }, target: { type: 'string' } }, []],
  ['browser_screenshot', 'Capture the current page as PNG.', { fullPage: { type: 'boolean' } }, []],
]

const MUTATING_TOOLS = new Set([
  'browser_open_url',
  'browser_navigate',
  'browser_click',
  'browser_type',
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

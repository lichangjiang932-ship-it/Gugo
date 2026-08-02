import { listAllSpecs, registerDynamicTool, unregisterByOrigin } from './toolRegistry.js'

const definitions = [
  ['browser_open_url', 'Open an http/https URL in the isolated local browser.', { url: { type: 'string' } }, ['url']],
  ['browser_state', 'Read the current browser URL, title and connection state.', {}, []],
  ['browser_snapshot', 'Read the current page text and interactive elements. Use returned refs for click/type.', { maxText: { type: 'integer', minimum: 1000, maximum: 50000 } }, []],
  ['browser_console', 'Read page console messages and uncaught exceptions.', { clear: { type: 'boolean' } }, []],
  ['browser_click', 'Click an element by snapshot ref (for example e3) or CSS selector.', { target: { type: 'string' } }, ['target']],
  ['browser_type', 'Fill an input by snapshot ref or CSS selector.', { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['target', 'text']],
  ['browser_wait', 'Wait for milliseconds or for an element to appear.', { ms: { type: 'integer', minimum: 0, maximum: 10000 }, target: { type: 'string' } }, []],
  ['browser_screenshot', 'Capture the current page as PNG.', { fullPage: { type: 'boolean' } }, []],
]

export function registerBrowserTools() {
  unregisterByOrigin('browser')
  for (const [name, description, properties, required] of definitions) {
    registerDynamicTool({
      name,
      origin: 'browser',
      source: 'local',
      spec: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    })
  }
}

export function listRegisteredBrowserToolSpecs() {
  return listAllSpecs()
    .filter((entry) => entry.origin === 'browser')
    .map((entry) => entry.tool)
}

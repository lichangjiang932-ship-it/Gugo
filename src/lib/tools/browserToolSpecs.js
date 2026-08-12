function browserSpec(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  }
}

export const BROWSER_TOOL_SPECS = Object.freeze({
  browser_open_url: browserSpec(
    'browser_open_url',
    'Open or navigate to an http/https URL in the isolated local browser. browser_navigate is the standard-name alias.',
    { url: { type: 'string' } },
    ['url'],
  ),
  browser_navigate: browserSpec(
    'browser_navigate',
    'Navigate the isolated local browser to an http/https URL. Use browser_snapshot after navigation to obtain fresh element refs.',
    { url: { type: 'string' } },
    ['url'],
  ),
  browser_state: browserSpec('browser_state', 'Read the current browser URL, title and connection state.'),
  browser_snapshot: browserSpec(
    'browser_snapshot',
    'Read page text and interactive elements. Use returned refs for click/type/select/press and refresh refs after DOM changes.',
    { maxText: { type: 'integer', minimum: 1000, maximum: 50000 } },
  ),
  browser_console: browserSpec(
    'browser_console',
    'Read page console messages and uncaught exceptions.',
    { clear: { type: 'boolean' } },
  ),
  browser_click: browserSpec(
    'browser_click',
    'Click an element by snapshot ref (for example e3) or CSS selector.',
    { target: { type: 'string' } },
    ['target'],
  ),
  browser_type: browserSpec(
    'browser_type',
    'Fill an input by snapshot ref or CSS selector.',
    { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
    ['target', 'text'],
  ),
  browser_select: browserSpec(
    'browser_select',
    'Select an option by snapshot ref or CSS selector, matching its value or visible label.',
    { target: { type: 'string' }, value: { type: 'string' } },
    ['target', 'value'],
  ),
  browser_press: browserSpec(
    'browser_press',
    'Press a keyboard key on an element or the focused page.',
    { target: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 64 } },
    ['key'],
  ),
  browser_wait: browserSpec(
    'browser_wait',
    'Wait for milliseconds or for an element to appear.',
    { ms: { type: 'integer', minimum: 0, maximum: 10000 }, target: { type: 'string' } },
  ),
  browser_screenshot: browserSpec(
    'browser_screenshot',
    'Capture the current page as PNG.',
    { fullPage: { type: 'boolean' } },
  ),
})

export const BROWSER_TOOL_NAMES = Object.freeze(Object.keys(BROWSER_TOOL_SPECS))

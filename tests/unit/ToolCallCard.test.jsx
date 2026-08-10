import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import ToolCallCard from '../../src/components/ToolCallCard.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

function renderToolCall(name, args) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ToolCallCard call={{ name, arguments: JSON.stringify(args), status: 'running' }} stepNumber={1} />
    </I18nProvider>,
  )
}

test('code-search tool summaries use the executor argument names', () => {
  assert.match(renderToolCall('grep_code', { pattern: 'executeToolCall' }), /executeToolCall/)
  assert.match(renderToolCall('find_symbol', { name: 'buildToolSpecs' }), /buildToolSpecs/)
})

test('failed command keeps arguments and result in independent disclosures', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(
      <I18nProvider>
        <ToolCallCard call={{
          name: 'bash_exec',
          arguments: JSON.stringify({ command: 'python broken.py' }),
          status: 'error',
          error: 'Command failed',
          result: JSON.stringify({
            ok: false,
            code: 'COMMAND_FAILED',
            exitCode: 2,
            stderr: 'SyntaxError: invalid syntax',
          }),
        }} stepNumber={2} />
      </I18nProvider>,
    ))

    const disclosures = rootElement.querySelectorAll('details')
    assert.equal(disclosures.length, 2)
    assert.equal(disclosures.item(0).open, false)
    assert.equal(disclosures.item(1).open, true)
    assert.match(disclosures.item(0).querySelector('summary').textContent, /参数/)
    assert.match(disclosures.item(1).querySelector('summary').textContent, /错误/)
    assert.equal(rootElement.querySelector('.chat-tool-step-marker').textContent, '2')

    const resultDetails = disclosures.item(1).querySelector('pre')?.textContent || ''
    assert.match(resultDetails, /COMMAND_FAILED/)
    assert.match(resultDetails, /"exitCode": 2/)
    assert.match(resultDetails, /SyntaxError: invalid syntax/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

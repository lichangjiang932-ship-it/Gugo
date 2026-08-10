import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { ToolCallTrace } from '../../src/pages/ChatSplit/chatMessages/ActivityTraces.jsx'

function renderTrace(calls) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ToolCallTrace calls={calls} />
    </I18nProvider>,
  )
}

test('ToolCallTrace renders an accessible summary and numbered running steps', () => {
  const markup = renderTrace([
    { id: 'read-1', name: 'read_file', arguments: '{"path":"D:/work/a.js"}', status: 'success' },
    { id: 'bash-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'running' },
  ])

  assert.match(markup, /aria-expanded="true"/)
  assert.match(markup, /aria-controls=/)
  assert.match(markup, /执行过程/)
  assert.match(markup, /进行中 · 1 步/)
  assert.match(markup, />1<\/div>/)
  assert.match(markup, />2<\/div>/)
  assert.equal((markup.match(/data-testid="tool-call-step"/g) || []).length, 2)
})

test('ToolCallTrace omits empty and invalid call lists', () => {
  assert.equal(renderTrace([]), '')
  assert.equal(renderTrace(null), '')
})

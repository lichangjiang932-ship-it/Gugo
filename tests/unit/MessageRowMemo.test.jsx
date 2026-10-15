import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

const t = (key) => key

test('streaming the current answer does not re-read unchanged historical message rows', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement']) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  let reads = 0
  const historical = { id: 'old', role: 'assistant', timestamp: 1, meta: {} }
  Object.defineProperty(historical, 'content', { enumerable: true, get() { reads += 1; return 'A previous answer.' } })
  const current = { id: 'current', role: 'assistant', content: 'A', timestamp: 2, meta: { streaming: true } }
  const props = { lang: 'en', t, generatingMessageId: 'current' }
  const render = (message) => act(async () => root.render(<I18nProvider>
    <MessageRow {...props} msg={historical} rowKey="old" turnIndex={0} />
    <MessageRow {...props} msg={message} rowKey="current" turnIndex={1} />
  </I18nProvider>))
  try {
    await render(current)
    const originalReads = reads
    assert.ok(originalReads > 0)
    await render({ ...current, content: 'A new streaming delta.' })
    assert.equal(reads, originalReads)
    assert.match(document.body.textContent, /A new streaming delta/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

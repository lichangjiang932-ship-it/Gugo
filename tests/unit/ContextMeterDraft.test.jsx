import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import useChatContextUsage from '../../src/pages/ChatSplit/useChatContextUsage.js'
import ComposerActions from '../../src/pages/ChatSplit/chatComposer/ComposerActions.jsx'
const messages = [{ id: 'u', role: 'user', content: 'Hello' }, { id: 'a', role: 'assistant', content: 'A previous answer', meta: { actualPromptTokens: 800 } }]
function Harness(props) {
  const { t } = useT(), ref = useRef(null), [open, setOpen] = useState(false)
  const usage = useChatContextUsage({ messages, contextToolSpecs: [], contextSystemPrompt: '', contextWindow: 128000, contextWindowAuthoritative: true,
    recoveryOwnerScope: 'owner', activeSessionId: 'session', selectedModel: 'm', selectedModelProviderId: 'p', ...props })
  return <ComposerActions contextUsage={usage} approvalMode="normal" contextPanelOpen={open} fileInputRef={ref} isGenerating={false}
    modelOptions={[]} modelPickerOpen={false} onToggleContext={() => setOpen(value => !value)} onApprovalModeChange={() => {}} t={t} />
}
test('real composer hook updates on drafts and attachments; both views agree and old input stays historical', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(document.getElementById('root'))
  const render = async props => { await act(async () => root.render(<I18nProvider><Harness {...props} /></I18nProvider>)) }
  try {
    await render({ input: '', attachments: [] })
    const ring = document.querySelector('[data-testid=context-ring]'), first = ring.title
    await render({ input: '中文草稿'.repeat(4000), attachments: [] })
    assert.notEqual(ring.title, first)
    assert.match(ring.title, /估算/)
    const withDraft = ring.title
    await render({ input: '中文草稿'.repeat(4000), attachments: [{ name: 'a.txt', text: '附件文本'.repeat(2000) }] })
    assert.notEqual(ring.title, withDraft)
    await act(async () => ring.click())
    assert.match(document.querySelector('[data-testid=context-usage-panel]').textContent, /上下文已用/)
    assert.equal(document.querySelector('[data-testid=context-last-request]'), null)
    await render({ input: '', attachments: [{ name: 'unread.pdf' }], selectedModel: 'other', contextWindowAuthoritative: false, contextWindowKnown: false })
    assert.match(ring.title, /有效窗口未知/)
    assert.doesNotMatch(ring.title, /128,000|%/)
    assert.ok(document.querySelector('[data-testid=context-unmeasured-attachments]'))
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

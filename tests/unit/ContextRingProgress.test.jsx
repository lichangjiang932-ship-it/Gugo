import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import ComposerActions from '../../src/pages/ChatSplit/chatComposer/ComposerActions.jsx'
import useChatContextUsage from '../../src/pages/ChatSplit/useChatContextUsage.js'

function Harness({ retained = 7000, input = '', selectedModel = 'm', known = true }) {
  const { t } = useT(), ref = useRef(), [open, setOpen] = useState(false)
  const observation = { version: 1, stage: 'retained', requestId: 'r'+retained, physicalAttempt: 1, modelName: 'm', providerId: 'p',
    configuredModelName: 'm', configuredProviderId: 'p', configRevision: null, contextWindow: 10000, inputEstimatedTokens: 8000, inputTokens: 8000, retainedEstimatedTokens: retained }
  const messages = [{ id: 'u', role: 'user', content: 'fixture' }, { id: 'a', role: 'assistant', content: 'fixture answer', meta: { modelContextUsage: observation, modelUsage: { promptTokens: 9999999, cacheHitTokens: 9999999 } } }]
  const usage = useChatContextUsage({ messages, contextToolSpecs: [], contextSystemPrompt: '', contextWindow: 20000, contextWindowAuthoritative: known,
    contextWindowKnown: known, contextWindowEstimated: false,
    input, selectedModel, selectedModelProviderId: 'p', recoveryOwnerScope: 'fixture', activeSessionId: 's' })
  return <ComposerActions contextUsage={usage} approvalMode="normal" contextPanelOpen={open} onToggleContext={() => setOpen(value => !value)} fileInputRef={ref}
    modelPickerOpen={false} modelOptions={[]} isGenerating={false} onApprovalModeChange={() => {}} t={t} />
}
test('the production composer arc tracks 0/25/70/99%, draft growth and compaction, not cumulative/cache usage', async context => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  const render = async props => { await act(async () => root.render(<I18nProvider><Harness {...props} /></I18nProvider>)) }
  const fraction = () => {
    const arc = document.querySelector('[data-testid=context-ring-arc]')
    return arc ? 1 - Number(arc.getAttribute('stroke-dashoffset')) / Number(arc.getAttribute('stroke-dasharray')) : 0
  }
  for (const percent of [0, 25, 70, 99]) {
    await render({ retained: percent * 100 })
    assert.ok(Math.abs(fraction() - percent / 100) < .0001)
    assert.ok(document.querySelector('[data-testid=context-ring]').title.includes(percent+'%'))
  }
  await render({ retained: 7000, input: '草稿'.repeat(100) })
  assert.ok(fraction() > .7)
  await render({ retained: 2000 })
  assert.ok(Math.abs(fraction() - .2) < .0001)
  await act(async () => document.querySelector('[data-testid=context-ring]').click())
  assert.match(document.querySelector('[data-testid=context-usage-panel]').textContent, /20%/)
  await render({ retained: 7000, selectedModel: 'other', known: false })
  assert.match(document.querySelector('[data-testid=context-ring]').title, /有效窗口未知/)
  assert.equal(fraction(), 0)
  await render({ retained: 7000, selectedModel: 'other', known: true })
  assert.ok(fraction() < .1, 'a different model does not reuse the previous request baseline')
})

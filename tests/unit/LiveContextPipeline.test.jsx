import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { contextUsageObservation } from '../../server/services/loop/contextUsageObservation.js'
import { dispatchTurnEvent } from '../../src/lib/turnClient/turnEventDispatch.js'
import { reduceMessageState } from '../../src/store/reducers/messageReducer.js'
import useChatContextUsage from '../../src/pages/ChatSplit/useChatContextUsage.js'
import ComposerActions from '../../src/pages/ChatSplit/chatComposer/ComposerActions.jsx'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
function View({ messages }) {
  const ref = useRef(null), { t } = useT()
  const usage = useChatContextUsage({ messages, contextToolSpecs: [], contextSystemPrompt: '', contextWindow: 128000, contextWindowAuthoritative: false,
    activeSessionId: 's', recoveryOwnerScope: 'owner', selectedModel: 'm', selectedModelProviderId: 'durable', selectedConfigRevision: 2 })
  return <ComposerActions contextUsage={usage} approvalMode="normal" fileInputRef={ref} modelPickerOpen={false} modelOptions={[]} isGenerating={true} t={t} />
}
test('fenced production observations flow through event dispatch and reducer into a live ring before final completion', async context => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  const server = { job: { modelName: 'm', modelProviderId: 'durable' }, contextWindow: 10000, activeToolSpecs: [], convo: [{ role: 'user', content: '中'.repeat(3000) }],
    modelInvocation: { id: 'request1', providerId: 'durable', configRevision: 2, providerAttempts: [{ sequence: 1, failoverIndex: 0, modelName: 'm', providerId: 'runtime-key' }] } }
  let state = { activeSessionId: 's', sessions: [{ id: 's', messages: [{ id: 'u', role: 'user', content: server.convo[0].content }, { id: 'a', role: 'assistant', content: '', meta: { streaming: true } }] }] }, sequence = 0
  const emit = async (type, payload) => {
    await dispatchTurnEvent({ id: 'event'+sequence, sessionId: 's', turnId: 't', sequence: ++sequence, type, payload, createdAt: sequence }, {
      messageTarget: { sessionId: 's', messageId: 'a' }, dispatch: action => { state = reduceMessageState(state, action) || state },
    })
    await act(async () => root.render(<I18nProvider><View messages={state.sessions[0].messages} /></I18nProvider>))
  }
  const fraction = () => {
    const node = document.querySelector('[data-testid=context-ring-arc]')
    return node ? 1 - Number(node.getAttribute('stroke-dashoffset')) / Number(node.getAttribute('stroke-dasharray')) : 0
  }
  const prepared = contextUsageObservation(server, { stage: 'prepared' })
  await emit('model.phase', { phase: 'wire_prepared', contextUsage: prepared })
  assert.ok(Math.abs(fraction()-prepared.inputEstimatedTokens/10000)<.0001)
  const initial = fraction(), content = 'Live output '.repeat(300)
  await emit('assistant.delta', { text: content })
  assert.ok(fraction()>initial, 'streamed text grows the meter without waiting for a final answer')
  server.convo.push({ role: 'assistant', content })
  const completed = contextUsageObservation(server, { stage: 'completed', inputTokens: 4000 })
  await emit('model.phase', { phase: 'completed', contextUsage: completed })
  assert.ok(Math.abs(fraction()-completed.retainedEstimatedTokens/10000)<.0001)
  server.convo.push({ role: 'tool', content: 'Tool result '.repeat(500) })
  const retained = contextUsageObservation(server, { stage: 'retained' })
  await emit('model.phase', { phase: 'context_usage', contextUsage: retained })
  assert.ok(Math.abs(fraction()-retained.retainedEstimatedTokens/10000)<.0001)
  server.modelInvocation.id = 'request2'
  server.convo = [{ role: 'user', content: 'Compacted summary' }]
  const compacted = contextUsageObservation(server, { stage: 'prepared' })
  await emit('model.phase', { phase: 'wire_prepared', contextUsage: compacted })
  assert.ok(fraction()<initial, 'a new compacted request replaces the archived UI history estimate')
})

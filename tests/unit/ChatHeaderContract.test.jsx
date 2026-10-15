import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Header from '../../src/pages/ChatSplit/chatSplitView/ChatSessionHeaderBar.jsx'
import usePlanCardState from '../../src/pages/ChatSplit/usePlanCardState.js'
const t = key => key
function Harness({ todos }) {
  const [workbench, setWorkbench] = useState(false), [preview, setPreview] = useState(false)
  const plan = usePlanCardState({ activeSession: { todos } })
  return <><Header activeSession={{ title: 'Actual title', todos }} planVisible={plan.planCardVisible} onOpenPlan={plan.onOpenPlan} onClosePlan={plan.onClosePlan}
    workbenchOpen={workbench} onWorkbenchToggle={() => setWorkbench(value => !value)} previewOpen={preview} onOpenPreview={() => setPreview(value => !value)} t={t} />
    <output data-testid="state">{JSON.stringify({ plan: plan.planCardVisible, workbench, preview })}</output></>
}
test('real header controls preserve independent plan/workbench/preview state, close by keyboard and reopen only on changed todos', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(document.getElementById('root'))
  const todos = [{ id: 'a', content: 'Check behavior', status: 'pending' }]
  const state = () => JSON.parse(document.querySelector('[data-testid=state]').textContent)
  const click = async id => act(async () => document.querySelector(`[data-testid=${id}]`).click())
  try {
    await act(async () => root.render(<Harness todos={todos} />))
    assert.equal(document.querySelector('[data-testid=chat-session-title]').textContent, 'Actual title')
    assert.equal(state().plan, false)
    await click('header-plan-toggle'); assert.equal(state().plan, true)
    await click('workbench-toggle'); assert.deepEqual(state(), { plan: true, workbench: true, preview: false })
    assert.equal(document.querySelector('[data-testid=workbench-toggle]').getAttribute('aria-expanded'), 'true')
    await click('chat-preview-toggle'); assert.equal(state().preview, true)
    await act(async () => document.querySelector('[data-testid=header-plan-toggle]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.deepEqual(state(), { plan: false, workbench: true, preview: true })
    await act(async () => root.render(<Harness todos={structuredClone(todos)} />)); assert.equal(state().plan, false)
    await act(async () => root.render(<Harness todos={[{ ...todos[0], status: 'completed' }]} />)); assert.equal(state().plan, true)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

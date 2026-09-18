import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SlashInlinePanelHost from '../../src/pages/ChatSplit/SlashInlinePanelHost.jsx'
import { persistSlashGoals } from '../../src/lib/slashGoals.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  return dom
}

async function renderPanel(props) {
  const dom = setupDom()
  const element = dom.window.document.getElementById('root')
  const root = createRoot(element)
  await act(async () => root.render(<SlashInlinePanelHost onClose={() => {}} {...props} />))
  return { dom, element, root }
}

async function cleanup(view) {
  await act(async () => view.root.unmount())
  view.dom.window.close()
}

async function changeValue(dom, element, value) {
  const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
  await act(async () => {
    element.focus()
    setter.call(element, value)
    element.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }))
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

test.skip('feedback panel validates and submits without rewriting the composer', async () => {
  const submissions = []
  const view = await renderPanel({ panel: 'feedback', onSubmitFeedback: (value) => submissions.push(value) })
  try {
    const panel = view.element.querySelector('[data-testid="slash-feedback-panel"]')
    const textarea = panel.querySelector('textarea')
    const save = [...panel.querySelectorAll('button')].at(-1)
    await act(async () => save.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(panel.textContent, /填写|Write/)
    await changeValue(view.dom, textarea, 'Make the panel calmer.')
    await act(async () => save.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(submissions, ['Make the panel calmer.'])
  } finally { await cleanup(view) }
})

test('persistSlashGoals creates a chat when goals are added from a draft', () => {
  const actions = []
  persistSlashGoals((action) => actions.push(action), null, [{ id: 'g1', text: 'Finish', done: false }], 'Goals')
  assert.equal(actions[0].type, 'NEW_SESSION')
  assert.equal(actions[1].type, 'SET_TODOS')
  assert.equal(actions[0].payload.id, actions[1].payload.sessionId)
})

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body) },
    async json() { return body },
  }
}

function planFixture(overrides = {}) {
  return {
    id: 'plan-1',
    objective: 'Fix the counter',
    status: 'awaiting_approval',
    revision: 1,
    version: 3,
    steps: [
      { id: 's1', ordinal: 0, title: 'Reproduce', status: 'pending', evidenceVerified: false },
      { id: 's2', ordinal: 1, title: 'Fix it', status: 'done', evidenceVerified: true },
    ],
    ...overrides,
  }
}

function stubGoalApi({ plan = planFixture(), calls = [] } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (target.startsWith('/api/goals/list')) {
      return jsonResponse({ ok: true, plans: plan ? [plan] : [] })
    }
    if (target.startsWith('/api/goals/show')) {
      return jsonResponse({ ok: true, plan, events: [] })
    }
    if (target.startsWith('/api/goals/approve')) {
      return jsonResponse({ ok: true, plan: { ...plan, status: 'approved', version: plan.version + 1 } })
    }
    if (target.startsWith('/api/goals/step')) {
      return jsonResponse({ ok: true, plan })
    }
    return jsonResponse({ ok: false, error: 'unexpected' }, 400)
  }
  return { restore: () => { globalThis.fetch = original }, calls }
}

test('goals panel shows the host-persisted plan and its verified steps', async () => {
  const api = stubGoalApi()
  const view = await renderPanel({ panel: 'goals', sessionId: 's1' })
  try {
    const panel = view.element.querySelector('[data-testid="slash-goals-panel"]')
    assert.ok(panel, 'panel renders')
    const plan = view.element.querySelector('[data-testid="slash-goals-plan"]')
    assert.ok(plan, 'server plan section renders')
    assert.match(plan.textContent, /Fix the counter/)
    assert.match(plan.textContent, /Reproduced|Reproduce/)
    assert.match(view.element.querySelector('[data-testid="slash-goals-plan-status"]').textContent, /awaiting|等待/u)
    assert.equal(view.element.querySelectorAll('[data-testid^="slash-goals-step-"]').length, 2)
    // The panel must say that only the agent can finish a step.
    assert.match(plan.textContent, /agent|宿主/u)
  } finally {
    api.restore()
    await cleanup(view)
  }
})

test('goals panel approves with the version it read, and never marks a step done', async () => {
  const api = stubGoalApi()
  const view = await renderPanel({ panel: 'goals', sessionId: 's1' })
  try {
    const approve = [...view.element.querySelectorAll('button')]
      .find((button) => /批准|Approve/.test(button.textContent))
    assert.ok(approve, 'an approve control is offered for an unapproved plan')
    await act(async () => approve.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
    const approval = api.calls.find((call) => call.url.startsWith('/api/goals/approve'))
    assert.ok(approval, 'approve was sent to the server')
    assert.deepEqual(approval.body, { planId: 'plan-1', expectedVersion: 3 })

    // Every step control the UI exposes must avoid `done`: completion needs
    // host-verifiable evidence that only the agent can cite.
    const stepCalls = api.calls.filter((call) => call.url.startsWith('/api/goals/step'))
    for (const call of stepCalls) assert.notEqual(call.body?.status, 'done')
  } finally {
    api.restore()
    await cleanup(view)
  }
})

test('goals panel surfaces a load failure instead of showing an empty plan', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ ok: false, error: 'unauthorized' }, 401)
  const view = await renderPanel({ panel: 'goals', sessionId: 's1' })
  try {
    const error = view.element.querySelector('[data-testid="slash-goals-error"]')
    assert.ok(error, 'the failure is visible')
    assert.equal(view.element.querySelector('[data-testid="slash-goals-plan"]'), null)
  } finally {
    globalThis.fetch = original
    await cleanup(view)
  }
})

test('legacy chat goals still render when a session has them', async () => {
  const api = stubGoalApi({ plan: null })
  const todos = [{ id: 'one', content: 'Inspect status', status: 'pending' }]
  const view = await renderPanel({ panel: 'goals', sessionId: 's1', todos, onGoalsChange: () => {} })
  try {
    const legacy = view.element.querySelector('[data-testid="slash-goals-legacy"]')
    assert.ok(legacy, 'legacy goals are preserved, not dropped')
    assert.match(legacy.textContent, /Inspect status/)
    assert.equal(view.element.querySelector('[data-testid="slash-goals-plan"]'), null)
  } finally {
    api.restore()
    await cleanup(view)
  }
})

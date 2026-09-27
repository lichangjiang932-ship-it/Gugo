import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import WorkbenchPlan from '../../src/pages/ChatSplit/rightWorkbench/WorkbenchPlan.jsx'
import { GOAL_PLAN_CHANGED_EVENT } from '../../src/lib/goalPlanSignals.js'
import { REVEAL_TURN_EVENT } from '../../src/lib/chatMessageSignals.js'

/**
 * The plan is a moving target: the agent edits it during a turn. These cover the
 * panel keeping up, saying what backs a step, and letting the reader act on it —
 * the three things that made the completion story visible only in the data layer.
 */
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key, vars = {}) => translateKey(key, 'zh').replace(/\{(\w+)\}/g, (_, name) => vars[name])

/** A stub whose answers can change between reads. */
function goalsStub() {
  const state = { plans: [], plan: null, approve: { ok: true }, calls: [] }
  const fetchImpl = async (url) => {
    const text = String(url)
    state.calls.push(text)
    if (text.includes('/api/goals/approve')) {
      const conflicted = state.approve?.ok === false
      return new Response(JSON.stringify(state.approve || { ok: true }), {
        status: conflicted ? 409 : 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const body = text.includes('/api/goals/show') ? { ok: true, plan: state.plan } : { ok: true, plans: state.plans }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, state }
}

async function renderPlan(props) {
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(<I18nProvider><WorkbenchPlan t={t} {...props} /></I18nProvider>)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { root, rootElement }
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

test('a plan the agent advanced mid-turn is re-read instead of staying frozen', async () => {
  const { fetchImpl, state } = goalsStub()
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = fetchImpl
  try {
    state.plans = [{ id: 'plan-1', status: 'approved' }]
    state.plan = {
      id: 'plan-1', status: 'approved', version: 1, objective: '推进任务',
      steps: [{ id: 's1', ordinal: 1, title: '第一步', status: 'in_progress' }],
    }
    const { root, rootElement } = await renderPlan({ sessionId: 'session-move', todos: [], artifacts: [] })
    assert.match(rootElement.textContent, /第一步/u)
    const readsBefore = state.calls.filter((call) => call.includes('/api/goals/show')).length

    // The agent finishes the step and the host verifies the evidence with it.
    state.plan = {
      ...state.plan,
      version: 2,
      steps: [{ id: 's1', ordinal: 1, title: '第一步', status: 'done', evidenceVerified: true, evidence: { turnId: 'turn-9', toolCallId: 'call-9' } }],
    }
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.CustomEvent(GOAL_PLAN_CHANGED_EVENT, {
        detail: { reason: 'goal_tool', toolName: 'goal_step_update' },
      }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // No remount and no close-and-reopen: the same panel shows the new state.
    const step = rootElement.querySelector('[data-testid="workbench-plan-step"]')
    assert.equal(step.getAttribute('data-status'), 'done')
    assert.equal(step.getAttribute('data-evidence'), 'verified')
    assert.ok(
      state.calls.filter((call) => call.includes('/api/goals/show')).length > readsBefore,
      'the panel re-read the plan rather than trusting the snapshot it opened with',
    )
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('the current plan is the one awaiting action, not the most recent row', async () => {
  const { fetchImpl, state } = goalsStub()
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = fetchImpl
  try {
    // A finished plan and an awaiting one are both on the server.
    state.plans = [{ id: 'plan-done', status: 'completed' }, { id: 'plan-wait', status: 'awaiting_approval' }]
    state.plan = {
      id: 'plan-wait', status: 'awaiting_approval', version: 3, objective: '等待批准的任务',
      steps: [{ id: 's1', ordinal: 1, title: '待批步骤', status: 'pending' }],
    }
    const { root, rootElement } = await renderPlan({ sessionId: 'session-pick', todos: [], artifacts: [] })

    assert.match(rootElement.textContent, /等待批准的任务/u)
    const asked = state.calls.find((call) => call.includes('/api/goals/show'))
    assert.match(String(asked), /planId=plan-wait/u, 'the plan awaiting action is the one shown')
    // A finished plan is labelled as such rather than passed off as current work.
    assert.equal(rootElement.querySelector('[data-testid="workbench-plan-status"]').getAttribute('data-status'), 'awaiting_approval')
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a step says whether anything backs it, and where that proof lives', async () => {
  const { fetchImpl, state } = goalsStub()
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = fetchImpl
  try {
    state.plans = [{ id: 'plan-1', status: 'approved' }]
    state.plan = {
      id: 'plan-1', status: 'approved', version: 4, objective: '证据',
      steps: [
        { id: 's1', ordinal: 1, title: '有宿主核验的步骤', status: 'done', evidenceVerified: true, evidence: { turnId: 'turn-1', toolCallId: 'call-1', note: '跑通了测试' } },
        { id: 's2', ordinal: 2, title: '自称完成但没有证据', status: 'done' },
        { id: 's3', ordinal: 3, title: '人工确认的步骤', status: 'done', evidence: { turnId: 'turn-2', manualConfirmed: true, confirmedBy: 'me' } },
      ],
    }
    const revealed = []
    const onReveal = (event) => revealed.push(event.detail.turnId)
    dom.window.addEventListener(REVEAL_TURN_EVENT, onReveal)
    const { root, rootElement } = await renderPlan({
      sessionId: 'session-evidence', todos: [], artifacts: [],
      onRevealTurn: (turnId) => dom.window.dispatchEvent(new dom.window.CustomEvent(REVEAL_TURN_EVENT, { detail: { turnId } })),
    })

    const steps = [...rootElement.querySelectorAll('[data-testid="workbench-plan-step"]')]
    // The three claims read differently: proven, unproven, and confirmed by hand.
    assert.deepEqual(steps.map((node) => node.getAttribute('data-evidence')), ['verified', 'missing', 'manual'])
    assert.match(rootElement.textContent, /已核验/u)
    assert.match(rootElement.textContent, /无证据/u)
    assert.match(rootElement.textContent, /人工确认/u)

    // The detail names the tool call and the turn behind the claim...
    await act(async () => steps[0].querySelector('[data-testid="workbench-plan-step-toggle"]').click())
    const detail = steps[0].querySelector('[data-testid="workbench-plan-step-evidence"]')
    assert.ok(detail)
    assert.match(detail.textContent, /call-1/u)
    assert.match(detail.textContent, /turn-1/u)
    assert.match(detail.textContent, /跑通了测试/u)

    // ...and the reader can ask to see that turn in the conversation.
    await act(async () => { detail.querySelector('[data-testid="workbench-plan-reveal-turn"]').click() })
    assert.deepEqual(revealed, ['turn-1'])

    dom.window.removeEventListener(REVEAL_TURN_EVENT, onReveal)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('an awaiting plan can be approved where it is shown, and a conflict is not hidden', async () => {
  const { fetchImpl, state } = goalsStub()
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = fetchImpl
  try {
    state.plans = [{ id: 'plan-1', status: 'awaiting_approval' }]
    state.plan = {
      id: 'plan-1', status: 'awaiting_approval', version: 7, objective: '待批准',
      steps: [{ id: 's1', ordinal: 1, title: '步骤', status: 'pending' }],
    }
    const { root, rootElement } = await renderPlan({ sessionId: 'session-approve', todos: [], artifacts: [] })

    const approve = rootElement.querySelector('[data-testid="workbench-plan-approve"]')
    assert.ok(approve, 'an awaiting plan offers approval where it is shown')

    // Someone else moved the plan: say so and re-read rather than retrying blindly
    // against the copy this panel is holding.
    state.approve = { ok: false, error: 'version conflict', currentVersion: 9 }
    await act(async () => {
      approve.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const note = rootElement.querySelector('[data-testid="workbench-plan-approve-note"]')
    assert.match(note.textContent, /已重新读取最新版本/u)
    assert.equal(state.calls.filter((call) => call.includes('/api/goals/approve')).length, 1)

    // The optimistic-concurrency version it sent is the one it was displaying.
    await settle()
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a step carries the same status mark as a task, including for a screen reader', async () => {
  const { fetchImpl, state } = goalsStub()
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = fetchImpl
  try {
    state.plans = [{ id: 'plan-1', status: 'approved' }]
    state.plan = {
      id: 'plan-1', status: 'approved', version: 1, objective: '一致性',
      steps: [
        { id: 's1', ordinal: 1, title: '完成的步骤', status: 'done' },
        { id: 's2', ordinal: 2, title: '进行中的步骤', status: 'in_progress' },
        { id: 's3', ordinal: 3, title: '受阻的步骤', status: 'blocked' },
      ],
    }
    const { root, rootElement } = await renderPlan({
      sessionId: 'session-marks', todos: [{ id: 'todo-1', content: '一个待办', status: 'in_progress' }], artifacts: [],
    })

    const tasks = [...rootElement.querySelectorAll('[data-testid="workbench-plan-task"]')]
    const steps = [...rootElement.querySelectorAll('[data-testid="workbench-plan-step"]')]
    // Both lists draw an icon; neither relies on colour alone to say what a row is.
    assert.ok(tasks[0].querySelector('svg'), 'a task shows a status icon')
    for (const step of steps) assert.ok(step.querySelector('svg'), 'a step shows a status icon')
    for (const step of steps) assert.ok(step.querySelector('.sr-only')?.textContent, 'a step states its status in words too')
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

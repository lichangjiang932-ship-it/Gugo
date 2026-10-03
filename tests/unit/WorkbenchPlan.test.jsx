import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import WorkbenchPlan from '../../src/pages/ChatSplit/rightWorkbench/WorkbenchPlan.jsx'

function setupDom(lang = 'zh') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  dom.window.localStorage.setItem('lang', lang)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key, vars = {}) => translateKey(key, 'zh').replace(/\{(\w+)\}/g, (_, name) => vars[name])

function stubGoals({ plans = [], plan = null } = {}) {
  return async (url) => {
    const text = String(url)
    const body = text.includes('/api/goals/show') ? { ok: true, plan } : { ok: true, plans }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
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

test('the plan panel shows the task list and the plan — progress, not files', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = stubGoals({
    plans: [{ id: 'plan-1', status: 'active' }],
    plan: {
      objective: '把版本对齐到 0.11.61',
      revision: 2,
      steps: [
        { id: 'step-1', ordinal: 1, title: '核对现状', status: 'done' },
        { id: 'step-2', ordinal: 2, title: '改版本号', status: 'pending' },
      ],
    },
  })
  try {
    const { root, rootElement } = await renderPlan({
      sessionId: 'session-1',
      todos: [
        { id: 'todo-1', content: '读文件', status: 'completed' },
        { id: 'todo-2', activeForm: '写报告', status: 'in_progress' },
        { id: 'todo-3', content: '收尾' },
      ],
    })

    // Two parts, each with its own count. The session's files are the
    // workbench's "workspace files" tool, not part of progress.
    assert.ok(rootElement.querySelector('[data-testid="workbench-plan-tasks"]'))
    assert.ok(rootElement.querySelector('[data-testid="workbench-plan-plan"]'))
    assert.equal(rootElement.querySelector('[data-testid="workbench-plan-output"]'), null)
    assert.deepEqual(
      [...rootElement.querySelectorAll('[data-testid="workbench-plan-task"]')].map((node) => node.getAttribute('data-status')),
      ['completed', 'in_progress', 'pending'],
    )
    assert.match(rootElement.textContent, /写报告/u)
    assert.match(rootElement.textContent, /把版本对齐到 0\.11\.61/u)
    assert.deepEqual(
      [...rootElement.querySelectorAll('[data-testid="workbench-plan-step"]')].map((node) => node.getAttribute('data-status')),
      ['done', 'pending'],
    )
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('each part says it is empty rather than showing nothing', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = stubGoals({ plans: [], plan: null })
  try {
    const { root, rootElement } = await renderPlan({ sessionId: 'session-2', todos: [] })
    assert.ok(rootElement.querySelector('[data-testid="workbench-plan-tasks-empty"]'))
    assert.ok(rootElement.querySelector('[data-testid="workbench-plan-empty"]'))
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a plan that cannot be read says so without losing the task list', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'plan store offline' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })
  try {
    const { root, rootElement } = await renderPlan({
      sessionId: 'session-3',
      todos: [{ id: 'todo-1', content: '读文件', status: 'completed' }],
    })

    const error = rootElement.querySelector('[data-testid="workbench-plan-error"]')
    assert.ok(error, 'the failure is reported where the plan would be')
    assert.match(error.textContent, /plan store offline/u)
    // The task list is independent of the plan.
    assert.equal(rootElement.querySelectorAll('[data-testid="workbench-plan-task"]').length, 1)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

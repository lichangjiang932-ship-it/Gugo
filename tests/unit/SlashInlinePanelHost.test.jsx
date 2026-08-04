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

test.skip('goals panel adds, completes, and removes compatible todo items', async () => {
  let todos = [{ id: 'one', content: 'Inspect status', status: 'pending' }]
  const changes = []
  const view = await renderPanel({ panel: 'goals', todos, onGoalsChange: (next) => { todos = next; changes.push(next) } })
  try {
    const panel = view.element.querySelector('[data-testid="slash-goals-panel"]')
    const toggle = [...panel.querySelectorAll('button')].find((button) => /标记|Mark/.test(button.getAttribute('aria-label') || ''))
    await act(async () => toggle.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(changes[0][0].status, 'completed')
    const input = panel.querySelector('input')
    await changeValue(view.dom, input, 'Ship the redesign')
    const add = [...panel.querySelectorAll('button')].find((button) => /添加|Add/.test(button.textContent))
    await act(async () => add.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(changes.at(-1).at(-1).text, 'Ship the redesign')
  } finally { await cleanup(view) }
})

test('persistSlashGoals creates a chat when goals are added from a draft', () => {
  const actions = []
  persistSlashGoals((action) => actions.push(action), null, [{ id: 'g1', text: 'Finish', done: false }], 'Goals')
  assert.equal(actions[0].type, 'NEW_SESSION')
  assert.equal(actions[1].type, 'SET_TODOS')
  assert.equal(actions[0].payload.id, actions[1].payload.sessionId)
})

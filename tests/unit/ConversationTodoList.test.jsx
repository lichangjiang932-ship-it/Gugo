import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ConversationTodoList from '../../src/pages/ChatSplit/chatMessages/ConversationTodoList.jsx'

const t = (key, values = {}) => key.replace(/\{(\w+)\}/g, (_, name) => values[name])

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

async function renderTodos(props) {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => root.render(<ConversationTodoList t={t} {...props} />))
  return {
    rootElement,
    async cleanup() {
      await act(async () => root.unmount())
      dom.window.close()
    },
  }
}

test('the conversation task list shows progress and the current item in the transcript', async () => {
  const view = await renderTodos({
    active: true,
    todos: [
      { content: 'Read the spec', status: 'completed' },
      { content: 'Build the page', activeForm: 'Building the page', status: 'in_progress' },
      { content: 'Check output', status: 'pending' },
    ],
  })
  try {
    const section = view.rootElement.querySelector('[data-testid="conversation-todos"]')
    assert.ok(section)
    assert.equal(section.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '1')
    assert.equal(section.querySelector('[role="progressbar"]').getAttribute('aria-valuemax'), '3')
    const items = [...view.rootElement.querySelectorAll('[data-testid="conversation-todo-items"] li')]
    assert.deepEqual(items.map((item) => item.dataset.status), ['completed', 'in_progress', 'pending'])
    assert.match(items[1].textContent, /Building the page/)
    assert.equal(items[1].getAttribute('aria-current'), 'step')
  } finally {
    await view.cleanup()
  }
})

test('the inline list retires after a finished turn but stays visible while the turn runs', async () => {
  const todos = [
    { content: 'Read the spec', status: 'completed' },
    { content: 'Ship it', status: 'completed' },
  ]
  const idle = await renderTodos({ active: false, todos })
  try {
    assert.equal(idle.rootElement.querySelector('[data-testid="conversation-todos"]'), null)
  } finally {
    await idle.cleanup()
  }
  const running = await renderTodos({ active: true, todos })
  try {
    assert.ok(running.rootElement.querySelector('[data-testid="conversation-todos"]'))
  } finally {
    await running.cleanup()
  }
})

test('legacy slash goals render in the same inline list', async () => {
  const view = await renderTodos({ active: true, todos: [{ text: 'Old goal', done: false }] })
  try {
    const item = view.rootElement.querySelector('[data-testid="conversation-todo-items"] li')
    assert.equal(item.dataset.status, 'pending')
    assert.match(item.textContent, /Old goal/)
  } finally {
    await view.cleanup()
  }
})

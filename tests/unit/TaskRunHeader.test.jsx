import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import TaskRunHeader from '../../src/pages/taskRun/TaskRunHeader.jsx'
import { describeTaskModelReadiness } from '../../src/pages/taskRun/taskModelReadiness.js'

test('task model readiness exposes the five durable user-facing states', () => {
  const cases = [
    ['unconfigured', 'unconfigured'],
    ['provider-unverified', 'untested'],
    ['provider-chat-only', 'chat-only'],
    ['ready', 'agent-ready'],
    ['provider-unavailable', 'unavailable'],
    ['error', 'unavailable'],
  ]
  for (const [kind, state] of cases) {
    assert.equal(describeTaskModelReadiness({ kind }).state, state)
  }
})

test('task header shows readiness before submit and keeps configuration and retry actionable', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/task',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let configureCount = 0
  let retryCount = 0
  let autoRetryEnabled = false
  const renderHeader = (modelReadiness) => root.render(
    <TaskRunHeader
      prompt="run a task"
      setPrompt={() => {}}
      submitting={false}
      modelName="local-agent"
      modelReadiness={modelReadiness}
      autoRetryEnabled={autoRetryEnabled}
      setAutoRetryEnabled={(enabled) => { autoRetryEnabled = enabled }}
      onConfigureModels={() => { configureCount += 1 }}
      onRetryModelStatus={() => { retryCount += 1 }}
      onCreate={() => {}}
      t={(key) => key}
    />,
  )

  try {
    await act(async () => renderHeader({ kind: 'provider-unverified', canSend: false }))
    const status = rootElement.querySelector('[data-testid="task-model-readiness"]')
    assert.equal(status.dataset.state, 'untested')
    assert.match(status.textContent, /taskCenter\.modelReadiness\.untested/)
    assert.match(status.textContent, /local-agent/)
    assert.equal(rootElement.querySelector('button[type="submit"]').disabled, true)
    const autoRetryCheckbox = rootElement.querySelector('input[type="checkbox"]')
    assert.ok(autoRetryCheckbox)
    assert.equal(autoRetryCheckbox.checked, false)
    await act(async () => autoRetryCheckbox.click())
    assert.equal(autoRetryEnabled, true)
    await act(async () => [...status.querySelectorAll('button')]
      .find((button) => button.textContent === 'taskCenter.modelReadiness.configure').click())
    assert.equal(configureCount, 1)

    await act(async () => renderHeader({ kind: 'ready', canSend: true }))
    assert.equal(rootElement.querySelector('[data-testid="task-model-readiness"]').dataset.state, 'agent-ready')
    assert.equal(rootElement.querySelector('button[type="submit"]').disabled, false)

    await act(async () => renderHeader({ kind: 'error', canSend: false }))
    const retryButton = [...rootElement.querySelectorAll('[data-testid="task-model-readiness"] button')]
      .find((button) => button.textContent === 'taskCenter.modelReadiness.retry')
    assert.ok(retryButton)
    await act(async () => retryButton.click())
    assert.equal(retryCount, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('task creation model errors expose the model settings action', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/task',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let configureCount = 0

  try {
    await act(async () => root.render(
      <TaskRunHeader
        prompt="run a task"
        setPrompt={() => {}}
        submitting={false}
        error="模型服务尚未正确配置。"
        errorAction="configure_model"
        onConfigureModels={() => { configureCount += 1 }}
        onCreate={() => {}}
        t={(key) => key}
      />,
    ))

    const alert = rootElement.querySelector('[role="alert"]')
    assert.ok(alert)
    assert.match(alert.textContent, /模型服务尚未正确配置/)
    const configureButton = [...alert.querySelectorAll('button')]
      .find((button) => button.textContent === 'modelProviders.manage')
    assert.ok(configureButton)
    await act(async () => configureButton.click())
    assert.equal(configureCount, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('task model outcome errors expose recovery without treating recreation as configuration', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/task',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let recoveryCount = 0

  try {
    await act(async () => root.render(
      <TaskRunHeader
        prompt="run a task"
        setPrompt={() => {}}
        submitting={false}
        error="The request outcome is unknown."
        errorAction="verify_model_request"
        onConfigureModels={() => {}}
        onOpenModelRecovery={() => { recoveryCount += 1 }}
        onCreate={() => {}}
        t={(key) => key}
      />,
    ))

    const recoveryButton = [...rootElement.querySelectorAll('[role="alert"] button')]
      .find((button) => button.textContent === 'chatMessages.openModelRequestRecovery')
    assert.ok(recoveryButton)
    await act(async () => recoveryButton.click())
    assert.equal(recoveryCount, 1)

    await act(async () => root.render(
      <TaskRunHeader
        prompt="run a task"
        setPrompt={() => {}}
        submitting={false}
        error="Create a new job for the changed provider binding."
        errorAction="recreate_job"
        onConfigureModels={() => {}}
        onOpenModelRecovery={() => { recoveryCount += 1 }}
        onCreate={() => {}}
        t={(key) => key}
      />,
    ))
    assert.equal(rootElement.querySelectorAll('[role="alert"] button').length, 0)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

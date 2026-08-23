import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import JobOverviewCard from '../../src/pages/taskRun/JobOverviewCard.jsx'

test('a refreshed model failure keeps configure-model and retry actions on the job card', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/task?job=job-refresh',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let configureCount = 0
  let retryCount = 0
  const controller = {
    selectedJob: {
      id: 'job-refresh',
      title: 'Local model task',
      prompt: 'Run locally',
      status: 'failed',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: '无法连接模型服务。',
    },
    jobFailureRecovery: { action: 'configure_model', target: null },
    handleRetry: () => { retryCount += 1 },
    pendingPlan: null,
    pendingDirectoryRequest: null,
    pendingClarification: null,
  }

  try {
    await act(async () => root.render(
      <JobOverviewCard
        controller={controller}
        statusLabel={(status) => status}
        onOpenApprovals={() => {}}
        onConfigureModels={() => { configureCount += 1 }}
        t={(key) => key}
      />,
    ))

    const buttons = [...rootElement.querySelectorAll('button')]
    const configure = buttons.find((button) => button.textContent === 'modelProviders.manage')
    const retry = buttons.find((button) => button.textContent === 'taskCenter.retry')
    assert.ok(configure)
    assert.ok(retry)
    await act(async () => configure.click())
    await act(async () => retry.click())
    assert.equal(configureCount, 1)
    assert.equal(retryCount, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

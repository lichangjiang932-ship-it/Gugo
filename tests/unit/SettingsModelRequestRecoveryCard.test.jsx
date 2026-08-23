import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsModelRequestRecoveryCard from '../../src/components/settings/SettingsModelRequestRecoveryCard.jsx'

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

test('settings model request recovery card resumes a resolved job step', async () => {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    HTMLElement: globalThis.HTMLElement,
    window: globalThis.window,
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings?tab=recovery',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    if (calls.length === 1) {
      return response({
        recovery: {
          scopeKind: 'job',
          jobId: 'job/1',
          stepId: 'step 1',
          checkpointRevision: 3,
          modelRequestId: 'mr_job_1',
          providerId: 'provider-1',
          modelName: 'model-1',
          configRevision: 7,
          lastProviderAttempt: {
            sequence: 2,
            providerAttempt: 1,
            failoverIndex: 1,
            providerId: 'provider-backup',
            modelName: 'model-backup',
            providerKind: 'openai-compatible',
          },
          idempotencyKey: 'idem-1',
          status: 'resolved_pending_resume',
          resolution: 'not_sent',
        },
      })
    }
    return response({
      job: { id: 'job/1' },
      resume: { ready: true, jobId: 'job/1', stepId: 'step 1' },
    }, 202)
  }
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let opened = null

  try {
    await act(async () => {
      root.render(
        <SettingsModelRequestRecoveryCard
          target={{
            scopeKind: 'job',
            jobId: 'job/1',
            stepId: 'step 1',
            modelRequestId: 'mr_job_1',
          }}
          onOpenOriginalTask={(value) => { opened = value }}
          t={(key) => key}
        />,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    assert.ok(rootElement.querySelector('[data-testid="model-request-recovery-card"]'))
    const lastProvider = rootElement.querySelector('[data-testid="model-request-last-provider"]')
    assert.ok(lastProvider)
    assert.match(lastProvider.textContent, /provider-backup/u)
    assert.match(lastProvider.textContent, /model-backup/u)
    assert.match(lastProvider.textContent, /openai-compatible/u)
    assert.match(lastProvider.textContent, /modelRequestRecovery\.physicalAttempt 2/u)
    const continueButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent === 'modelRequestRecovery.continue')
    assert.ok(continueButton)
    await act(async () => {
      continueButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/jobs/job%2F1/steps/step%201/model-request-recovery',
      '/api/jobs/job%2F1/steps/step%201/model-request-recovery/resume',
    ])
    assert.deepEqual(opened, {
      record: { scopeKind: 'job', jobId: 'job/1', stepId: 'step 1' },
      resume: null,
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.document = previous.document
    globalThis.fetch = previous.fetch
    globalThis.HTMLElement = previous.HTMLElement
    globalThis.window = previous.window
  }
})

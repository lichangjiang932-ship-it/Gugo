import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import useTaskRunController from '../src/pages/taskRun/useTaskRunController.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/tasks',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.EventSource = undefined
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data }
}

function job(id, status = 'running') {
  return { id, status, events: [], prompt: id, createdAt: 1, updatedAt: 1 }
}

const t = (key) => key
const toast = { error() {}, success() {} }

function Harness({ linkedJobId, onReady }) {
  const controller = useTaskRunController({ linkedJobId, t, toast })
  useEffect(() => { onReady(controller) }, [controller, onReady])
  return null
}

async function flush() {
  await act(async () => {})
  await act(async () => {})
}

test('selecting another job clears the previous details now and ignores its late reply', async () => {
  setupDom()
  const deferred = new Map()
  let jobACalls = 0
  globalThis.fetch = async (url) => {
    if (url === '/api/jobs') return jsonResponse({ jobs: [job('job-a'), job('job-b')] })
    if (url === '/api/jobs/job-a') {
      jobACalls += 1
      if (jobACalls === 1) return jsonResponse({ job: job('job-a') })
      return new Promise((resolve) => deferred.set('a-late', () => resolve(jsonResponse({ job: job('job-a') }))))
    }
    if (url === '/api/jobs/job-b') {
      return new Promise((resolve) => deferred.set('b', () => resolve(jsonResponse({ job: job('job-b') }))))
    }
    if (url === '/api/model/status') {
      return jsonResponse({ ok: true, configured: false, models: [], modelName: '' })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const root = createRoot(document.getElementById('root'))
  const controllerRef = { current: null }
  try {
    await act(async () => root.render(<Harness linkedJobId="job-a" onReady={(controller) => { controllerRef.current = controller }} />))
    await flush()
    assert.equal(controllerRef.current.selectedJob?.id, 'job-a')

    await act(async () => { controllerRef.current.selectJob('job-b') })
    assert.equal(controllerRef.current.selectedJobId, 'job-b')
    assert.equal(controllerRef.current.selectedJob, null, 'the old job details are cleared immediately')

    // Move to A, then back to B; A's reply is now late and must not win.
    await act(async () => { controllerRef.current.selectJob('job-a') })
    assert.equal(controllerRef.current.selectedJob, null)
    await act(async () => { controllerRef.current.selectJob('job-b') })
    assert.equal(controllerRef.current.selectedJob, null)
    await act(async () => { deferred.get('a-late')?.() })
    await flush()
    assert.equal(controllerRef.current.selectedJob, null, 'a late reply for a job no longer selected is dropped')

    await act(async () => { deferred.get('b')?.() })
    await flush()
    assert.equal(controllerRef.current.selectedJob?.id, 'job-b')
  } finally {
    await act(async () => root.unmount())
    delete globalThis.fetch
    document.defaultView?.close?.()
  }
})

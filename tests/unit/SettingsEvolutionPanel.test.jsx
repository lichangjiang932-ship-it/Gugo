import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import SettingsEvolutionPanel from '../../src/components/settings/SettingsEvolutionPanel.jsx'
import { buildEvolutionDecisionInput } from '../../src/components/settings/evolutionDecision.js'
import {
  buildAutopilotEnabledPayload,
  resolveAutopilotModels,
} from '../../src/components/settings/evolutionPanel/useEvolutionAutopilot.js'
import { translations } from '../../src/i18n/translations.js'

let act
let createRoot

async function loadReactRuntime() {
  const [react, reactDom] = await Promise.all([
    import('react'),
    import('react-dom/client'),
  ])
  act = react.act
  createRoot = reactDom.createRoot
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings?tab=evolution',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.InputEvent = dom.window.InputEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const t = (key) => key

async function enterValue(dom, element, value) {
  const prototype = element.tagName === 'TEXTAREA'
    ? dom.window.HTMLTextAreaElement.prototype
    : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
  await act(async () => {
    element.focus()
    setter.call(element, value)
    element.dispatchEvent(new dom.window.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText',
    }))
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

async function selectValue(dom, element, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

async function click(dom, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonWithText(rootElement, text) {
  return [...rootElement.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text)
}

async function waitFor(predicate, context = '') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  assert.fail(`timed out waiting for UI state${context ? `: ${context()}` : ''}`)
}

test('evolution settings loads every local control-plane stage and exposes honest publication boundaries', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url) === '/api/evolution/auto-config') return json({ ok: true, config: null })
    if (String(url).startsWith('/api/evolution/auto-runs')) return json({ ok: true, runs: [] })
    if (String(url).startsWith('/api/evolution/evidence')) return json({ ok: true, evidence: [{ id: 'e-1', source: 'feedback', signal: 'clear errors' }] })
    if (String(url).startsWith('/api/evolution/candidates')) return json({ ok: true, candidates: [
      { id: 'c-1', kind: 'prompt', title: 'Prompt change', summary: 'safer output' },
      { id: 'c-2', kind: 'plugin', title: 'Plugin change', summary: 'new tool' },
    ] })
    if (String(url).startsWith('/api/evolution/evaluations')) return json({ ok: true, evaluations: [] })
    if (String(url).startsWith('/api/evolution/approvals')) return json({ ok: true, approvals: [] })
    if (String(url).startsWith('/api/evolution/canaries')) return json({ ok: true, canaries: [] })
    if (String(url).startsWith('/api/evolution/promotions')) return json({ ok: true, promotions: [] })
    if (String(url) === '/api/model/providers') return json({ ok: true, providers: [
      { id: 'provider-a', label: 'Provider A', enabled: true, models: ['shared-model'] },
      { id: 'provider-b', label: 'Provider B', enabled: true, models: ['shared-model'] },
    ] })
    throw new Error(`unexpected request: ${url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsEvolutionPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(requests.length, 9)
    assert.match(rootElement.textContent, /evolution\.autopilot/)
    assert.equal(rootElement.querySelector('.evolution-advanced').open, false)
    assert.match(rootElement.textContent, /evolution\.workflow/)
    assert.match(rootElement.textContent, /evolution\.prepareWorkflow/)
    assert.ok(rootElement.querySelector('[aria-label="evolution.candidateProvider"]'))
    assert.ok(rootElement.querySelector('[aria-label="evolution.candidateModel"]'))
    assert.ok(rootElement.querySelector('[aria-label="evolution.replayProvider"]'))
    assert.ok(rootElement.querySelector('[aria-label="evolution.replayModel"]'))
    assert.ok(rootElement.querySelector('[aria-label="evolution.evaluatorProvider"]'))
    assert.ok(rootElement.querySelector('[aria-label="evolution.evaluatorModel"]'))
    assert.deepEqual(
      [...rootElement.querySelectorAll('#evolution-provider-options option')].map((option) => option.value),
      ['provider-a', 'provider-b'],
    )
    assert.match(rootElement.textContent, /evolution\.promptBoundary/)
    assert.match(rootElement.textContent, /evolution\.unsupportedBoundary/)
    assert.doesNotMatch(requests.map((item) => item.url).join('\n'), /apply|install|deploy/u)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('evolution autopilot builds a one-click config without exposing session ids', () => {
  const models = resolveAutopilotModels([
    { id: 'primary', models: ['main-model'] },
    { id: 'reviewer', models: ['judge-model'] },
  ])
  const input = buildAutopilotEnabledPayload(null, models)
  assert.equal(input.enabled, true)
  assert.equal(input.target, 'prompt:workspace-instructions')
  assert.deepEqual(input.generator, { providerId: 'primary', modelName: 'main-model' })
  assert.deepEqual(input.replay, { providerId: 'primary', modelName: 'main-model' })
  assert.deepEqual(input.evaluator, { providerId: 'reviewer', modelName: 'judge-model' })
  assert.equal('sessionIds' in input, false)
})

test('automatic evolution requires an independent provider/model identity', () => {
  assert.equal(resolveAutopilotModels([
    { id: 'only', models: ['same-model'] },
  ]), null)
  assert.deepEqual(resolveAutopilotModels([
    { id: 'one', models: ['shared'] },
    { id: 'two', models: ['shared'] },
  ]), {
    generator: { providerId: 'one', modelName: 'shared' },
    replay: { providerId: 'one', modelName: 'shared' },
    evaluator: { providerId: 'two', modelName: 'shared' },
  })
})

test('controlled evolution submits the complete dataset-to-evaluation workflow without approving, enabling, or publishing', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), init }
    requests.push(request)
    const method = init.method || 'GET'
    if (request.url === '/api/evolution/auto-config') return json({ ok: true, config: null })
    if (request.url.startsWith('/api/evolution/auto-runs')) return json({ ok: true, runs: [] })
    if (request.url === '/api/evolution/dataset?limit=200') {
      return json({
        ok: true,
        dataset: {
          datasetFingerprint: 'dataset-fingerprint-1',
          records: [
            { id: 'record-1', cluster: 'quality', payload: { feedback: 'first signal' } },
            { id: 'record-2', cluster: 'safety', payload: { summary: 'second signal' } },
          ],
        },
      })
    }
    if (request.url === '/api/evolution/candidates/generate' && method === 'POST') {
      return json({ ok: true, candidate: { id: 'candidate-1' } }, 201)
    }
    if (request.url === '/api/evolution/replay-suites' && method === 'POST') {
      return json({ ok: true, suite: { id: 'suite-1' } }, 201)
    }
    if (request.url === '/api/evolution/replays/run' && method === 'POST') {
      return json({ ok: true, replay: { id: 'replay-1' } }, 201)
    }
    if (request.url === '/api/evolution/evaluations' && method === 'POST') {
      return json({ ok: true, evaluation: { id: 'evaluation-1', verdict: 'pass' } }, 201)
    }
    if (request.url.startsWith('/api/evolution/evidence')) return json({ ok: true, evidence: [] })
    if (request.url.startsWith('/api/evolution/candidates')) return json({ ok: true, candidates: [] })
    if (request.url.startsWith('/api/evolution/evaluations')) return json({ ok: true, evaluations: [] })
    if (request.url.startsWith('/api/evolution/approvals')) return json({ ok: true, approvals: [] })
    if (request.url.startsWith('/api/evolution/canaries')) return json({ ok: true, canaries: [] })
    if (request.url.startsWith('/api/evolution/promotions')) return json({ ok: true, promotions: [] })
    if (request.url === '/api/model/providers') return json({ ok: true, providers: [
      { id: 'candidate-provider', label: 'Candidate', enabled: true, models: ['candidate-model'] },
      { id: 'replay-provider', label: 'Replay', enabled: true, models: ['shared-model'] },
      { id: 'evaluator-provider', label: 'Evaluator', enabled: true, models: ['shared-model'] },
    ] })
    throw new Error(`unexpected request: ${request.url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsEvolutionPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await click(dom, buttonWithText(rootElement, 'evolution.prepareWorkflow'))
    await waitFor(() => rootElement.querySelectorAll('input[type="checkbox"]').length === 2)

    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.target"]'), ' prompt:test-target ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.objective"]'), ' Improve reliability ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.candidateProvider"]'), ' candidate-provider ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.candidateModel"]'), ' candidate-model ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.replayProvider"]'), ' replay-provider ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.replayModel"]'), ' shared-model ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.evaluatorProvider"]'), ' evaluator-provider ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.evaluatorModel"]'), ' shared-model ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.baselineContent"]'), ' Existing baseline prompt ')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.replayCases"]'), ' first replay input \n second replay input ')
    await click(dom, buttonWithText(rootElement, 'evolution.runWorkflow'))
    await waitFor(() => requests.some(({ url, init }) => (
      url === '/api/evolution/evaluations' && init.method === 'POST'
    )), () => JSON.stringify({
      requests: requests.map(({ url, init }) => ({ url, method: init.method || 'GET', body: init.body })),
      text: rootElement.textContent,
    }))
    await waitFor(() => rootElement.textContent.includes('evolution.workflowCompleted'))

    const writes = requests.filter(({ init }) => init.method === 'POST')
    assert.deepEqual(writes.map(({ url }) => url), [
      '/api/evolution/candidates/generate',
      '/api/evolution/replay-suites',
      '/api/evolution/replays/run',
      '/api/evolution/evaluations',
    ])
    assert.deepEqual(JSON.parse(writes[0].init.body), {
      kind: 'prompt',
      target: 'prompt:test-target',
      objective: 'Improve reliability',
      datasetFingerprint: 'dataset-fingerprint-1',
      sourceRecordIds: ['record-1', 'record-2'],
      providerId: 'candidate-provider',
      modelName: 'candidate-model',
    })
    assert.deepEqual(JSON.parse(writes[1].init.body), {
      name: 'Improve reliability',
      datasetFingerprint: 'dataset-fingerprint-1',
      cases: [
        { sourceRecordId: 'record-1', title: 'prompt:test-target #1', input: 'first replay input' },
        { sourceRecordId: 'record-2', title: 'prompt:test-target #2', input: 'second replay input' },
      ],
    })
    assert.deepEqual(JSON.parse(writes[2].init.body), {
      suiteId: 'suite-1',
      candidateId: 'candidate-1',
      baselineContent: 'Existing baseline prompt',
      providerId: 'replay-provider',
      modelName: 'shared-model',
      parameters: { temperature: 0, maxTokens: 1_024 },
    })
    assert.deepEqual(JSON.parse(writes[3].init.body), {
      replayId: 'replay-1',
      evaluatorProviderId: 'evaluator-provider',
      evaluatorModelName: 'shared-model',
    })
    assert.equal(writes.some(({ url }) => /approvals|canaries|apply|enable|publish|deploy/u.test(url)), false)

    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.evaluatorProvider"]'), ' replay-provider ')
    await click(dom, buttonWithText(rootElement, 'evolution.runWorkflow'))
    assert.ok(rootElement.textContent.includes('evolution.workflowIndependentModel'))
    assert.equal(requests.filter(({ init }) => init.method === 'POST').length, writes.length)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('canary UI freezes an independent grader, grades pending outcomes, and gates promotion on current evidence', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  const requests = []
  let canaryState = null
  let gradeRecorded = false
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), init }
    requests.push(request)
    const method = init.method || 'GET'
    if (request.url === '/api/evolution/canaries' && method === 'POST') {
      canaryState = 'created'
      return json({ ok: true, canary: { id: 'canary-1', state: canaryState } }, 201)
    }
    if (request.url === '/api/evolution/canaries/canary-1/rollback-policy' && method === 'POST') {
      return json({ ok: true, policy: { id: 'rollback-1' } }, 201)
    }
    if (request.url === '/api/evolution/canaries/canary-1/online-grader-policy' && method === 'POST') {
      return json({ ok: true, policy: { id: 'grader-1' } }, 201)
    }
    if (request.url === '/api/evolution/canaries/canary-1/start' && method === 'POST') {
      canaryState = 'active'
      return json({ ok: true, canary: { id: 'canary-1', state: canaryState } }, 201)
    }
    if (request.url === '/api/evolution/canaries/canary-1/stop' && method === 'POST') {
      canaryState = 'stopped'
      return json({ ok: true, canary: { id: 'canary-1', state: canaryState } })
    }
    if (request.url === '/api/evolution/canaries/canary-1/online-grades' && method === 'POST') {
      gradeRecorded = true
      return json({ ok: true, grade: { id: 'grade-1', status: 'completed' } }, 201)
    }
    if (request.url === '/api/evolution/canaries/canary-1/online-grades?limit=100') {
      return json({
        ok: true,
        state: {
          outcomes: [{
            id: 'outcome-1',
            variant: 'candidate',
            terminalState: 'completed',
            graded: gradeRecorded,
            gradeStatus: gradeRecorded ? 'completed' : null,
          }],
          currentEvidence: gradeRecorded
            ? { decision: 'continue', blockers: [], latestEvaluationCurrent: true }
            : { decision: 'insufficient_evidence', blockers: ['candidate_grade_missing'], latestEvaluationCurrent: false },
        },
      })
    }
    if (request.url.startsWith('/api/evolution/evidence')) return json({ ok: true, evidence: [] })
    if (request.url.startsWith('/api/evolution/candidates')) return json({ ok: true, candidates: [] })
    if (request.url.startsWith('/api/evolution/evaluations')) return json({ ok: true, evaluations: [] })
    if (request.url.startsWith('/api/evolution/approvals')) return json({ ok: true, approvals: [{ id: 'approval-1', decision: 'approved' }] })
    if (request.url.startsWith('/api/evolution/canaries?')) return json({
      ok: true,
      canaries: canaryState ? [{
        id: 'canary-1',
        state: canaryState,
        trafficPercent: 5,
        target: 'prompt:workspace-instructions',
        rollbackPolicyConfigured: true,
        onlineGraderPolicyConfigured: true,
      }] : [],
    })
    if (request.url.startsWith('/api/evolution/promotions')) return json({ ok: true, promotions: [] })
    if (request.url === '/api/model/providers') return json({ ok: true, providers: [{
      id: 'grader-provider',
      label: 'Independent grader',
      enabled: true,
      models: ['grader-model'],
    }] })
    throw new Error(`unexpected request: ${request.url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsEvolutionPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await selectValue(dom, rootElement.querySelector('[aria-label="evolution.approval"]'), 'approval-1')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.sessionIds"]'), 'session-1')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.onlineGraderProvider"]'), 'grader-provider')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.onlineGraderModel"]'), 'grader-model')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.onlineGraderRevision"]'), 'grader-revision-1')
    await click(dom, buttonWithText(rootElement, 'evolution.createCanary'))
    await waitFor(() => canaryState === 'created' && Boolean(buttonWithText(rootElement, 'evolution.start')))

    const policyRequest = requests.find(({ url }) => url.endsWith('/online-grader-policy'))
    assert.deepEqual(JSON.parse(policyRequest.init.body), {
      graderProviderId: 'grader-provider',
      graderModelName: 'grader-model',
      graderModelRevision: 'grader-revision-1',
      policy: {
        minimumQualityScore: 2,
        maximumQualityRegression: 0,
        maximumSafetyFailureRate: 0,
      },
      reason: 'evolution.onlineGraderPolicyReason',
    })
    assert.equal(buttonWithText(rootElement, 'evolution.start').disabled, false)
    await click(dom, buttonWithText(rootElement, 'evolution.start'))
    await waitFor(() => canaryState === 'active' && Boolean(buttonWithText(rootElement, 'evolution.onlineEvidence')))
    await click(dom, buttonWithText(rootElement, 'evolution.onlineEvidence'))
    await waitFor(() => Boolean(buttonWithText(rootElement, 'evolution.runOnlineGrade')))
    assert.match(rootElement.textContent, /candidate_grade_missing/u)
    await click(dom, buttonWithText(rootElement, 'evolution.runOnlineGrade'))
    await waitFor(() => gradeRecorded && !buttonWithText(rootElement, 'evolution.runOnlineGrade'))
    assert.match(rootElement.textContent, /evolution\.onlineEvidenceDecision: continue/u)
    await click(dom, buttonWithText(rootElement, 'evolution.stop'))
    await waitFor(() => canaryState === 'stopped' && Boolean(buttonWithText(rootElement, 'evolution.reviewPromotion')))
    assert.equal(buttonWithText(rootElement, 'evolution.reviewPromotion').disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('partial canary guardrail recovery only configures the missing grader policy and unlocks start', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  const requests = []
  let graderPolicyConfigured = false
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), init }
    requests.push(request)
    const method = init.method || 'GET'
    if (request.url === '/api/evolution/canaries/canary-partial/online-grader-policy' && method === 'POST') {
      graderPolicyConfigured = true
      return json({ ok: true, policy: { id: 'grader-policy-1' } }, 201)
    }
    if (request.url.startsWith('/api/evolution/canaries?')) return json({
      ok: true,
      canaries: [{
        id: 'canary-partial',
        state: 'created',
        trafficPercent: 5,
        target: 'prompt:workspace-instructions',
        rollbackPolicyConfigured: true,
        onlineGraderPolicyConfigured: graderPolicyConfigured,
      }],
    })
    if (request.url.startsWith('/api/evolution/evidence')) return json({ ok: true, evidence: [] })
    if (request.url.startsWith('/api/evolution/candidates')) return json({ ok: true, candidates: [] })
    if (request.url.startsWith('/api/evolution/evaluations')) return json({ ok: true, evaluations: [] })
    if (request.url.startsWith('/api/evolution/approvals')) return json({ ok: true, approvals: [] })
    if (request.url.startsWith('/api/evolution/promotions')) return json({ ok: true, promotions: [] })
    if (request.url === '/api/model/providers') return json({ ok: true, providers: [{
      id: 'grader-provider',
      label: 'Independent grader',
      enabled: true,
      models: ['grader-model'],
    }] })
    throw new Error(`unexpected request: ${request.url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsEvolutionPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => Boolean(buttonWithText(rootElement, 'evolution.configureCanaryGuardrails')))
    assert.equal(buttonWithText(rootElement, 'evolution.start').disabled, true)

    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.onlineGraderProvider"]'), 'grader-provider')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.onlineGraderModel"]'), 'grader-model')
    await enterValue(dom, rootElement.querySelector('[aria-label="evolution.onlineGraderRevision"]'), 'grader-revision-1')
    await click(dom, buttonWithText(rootElement, 'evolution.configureCanaryGuardrails'))
    await waitFor(() => graderPolicyConfigured && !buttonWithText(rootElement, 'evolution.configureCanaryGuardrails'))

    const rollbackRequests = requests.filter(({ url, init }) => (
      url.endsWith('/rollback-policy') && init.method === 'POST'
    ))
    const graderRequests = requests.filter(({ url, init }) => (
      url.endsWith('/online-grader-policy') && init.method === 'POST'
    ))
    assert.equal(rollbackRequests.length, 0)
    assert.equal(graderRequests.length, 1)
    assert.deepEqual(JSON.parse(graderRequests[0].init.body), {
      graderProviderId: 'grader-provider',
      graderModelName: 'grader-model',
      graderModelRevision: 'grader-revision-1',
      policy: {
        minimumQualityScore: 2,
        maximumQualityRegression: 0,
        maximumSafetyFailureRate: 0,
      },
      reason: 'evolution.onlineGraderPolicyReason',
    })
    assert.equal(buttonWithText(rootElement, 'evolution.start').disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('production promotion requires reviewed fingerprints and supports explicit revoke', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  const requests = []
  let promotionState = null
  const confirmations = {
    canaryReleaseFingerprint: 'a'.repeat(64),
    candidateContentSha256: 'b'.repeat(64),
    rollbackBaselineSha256: 'c'.repeat(64),
    rollbackPolicyFingerprint: 'd'.repeat(64),
    onlineGraderPolicyFingerprint: 'e'.repeat(64),
    onlineGuardEvaluationFingerprint: 'f'.repeat(64),
  }
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), init }
    requests.push(request)
    const method = init.method || 'GET'
    if (request.url === '/api/evolution/canaries/canary-1/promotion-review') {
      return json({
        ok: true,
        review: {
          canaryReleaseId: 'canary-1',
          candidate: { id: 'candidate-1', title: 'Safer prompt', summary: 'Reviewed candidate' },
          guard: { decision: 'continue', metrics: {} },
          confirmations,
        },
      })
    }
    if (request.url === '/api/evolution/canaries/canary-1/online-grades?limit=100') {
      return json({
        ok: true,
        state: {
          outcomes: [],
          currentEvidence: { decision: 'continue', blockers: [], latestEvaluationCurrent: true },
        },
      })
    }
    if (request.url === '/api/evolution/promotions' && method === 'POST') {
      promotionState = 'active'
      return json({ ok: true, promotion: { id: 'promotion-1', state: 'active' } }, 201)
    }
    if (request.url === '/api/evolution/promotions/promotion-1/revoke' && method === 'POST') {
      promotionState = 'revoked'
      return json({ ok: true, promotion: { id: 'promotion-1', state: 'revoked' } })
    }
    if (request.url.startsWith('/api/evolution/promotions?')) {
      return json({
        ok: true,
        promotions: promotionState
          ? [{ id: 'promotion-1', state: promotionState, target: 'prompt:workspace-instructions' }]
          : [],
      })
    }
    if (request.url.startsWith('/api/evolution/evidence')) return json({ ok: true, evidence: [] })
    if (request.url.startsWith('/api/evolution/candidates')) return json({ ok: true, candidates: [] })
    if (request.url.startsWith('/api/evolution/evaluations')) return json({ ok: true, evaluations: [] })
    if (request.url.startsWith('/api/evolution/approvals')) return json({ ok: true, approvals: [] })
    if (request.url.startsWith('/api/evolution/canaries')) return json({
      ok: true,
      canaries: [{ id: 'canary-1', state: 'stopped', trafficPercent: 10, target: 'prompt:workspace-instructions' }],
    })
    if (request.url === '/api/model/providers') return json({ ok: true, providers: [] })
    throw new Error(`unexpected request: ${request.url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsEvolutionPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => Boolean(buttonWithText(rootElement, 'evolution.onlineEvidence')))
    await click(dom, buttonWithText(rootElement, 'evolution.onlineEvidence'))
    await waitFor(() => Boolean(buttonWithText(rootElement, 'evolution.reviewPromotion'))
      && !buttonWithText(rootElement, 'evolution.reviewPromotion').disabled)
    await click(dom, buttonWithText(rootElement, 'evolution.reviewPromotion'))
    await waitFor(() => Boolean(rootElement.querySelector('[aria-label="evolution.promotionReason"]')))
    assert.match(rootElement.textContent, new RegExp(confirmations.canaryReleaseFingerprint))
    assert.equal(buttonWithText(rootElement, 'evolution.activatePromotion').disabled, true)
    await enterValue(
      dom,
      rootElement.querySelector('[aria-label="evolution.promotionReason"]'),
      ' Promote after reviewed canary ',
    )
    await click(dom, rootElement.querySelector('input[type="checkbox"]'))
    assert.equal(buttonWithText(rootElement, 'evolution.activatePromotion').disabled, false)
    await click(dom, buttonWithText(rootElement, 'evolution.activatePromotion'))
    await waitFor(() => promotionState === 'active' && Boolean(buttonWithText(rootElement, 'evolution.revokePromotion')))
    const createRequest = requests.find(({ url, init }) => (
      url === '/api/evolution/promotions' && init.method === 'POST'
    ))
    assert.deepEqual(JSON.parse(createRequest.init.body), {
      canaryReleaseId: 'canary-1',
      reason: 'Promote after reviewed canary',
      confirmations,
    })

    await click(dom, buttonWithText(rootElement, 'evolution.revokePromotion'))
    await waitFor(() => promotionState === 'revoked')
    const revokeRequest = requests.find(({ url }) => url.endsWith('/promotion-1/revoke'))
    assert.deepEqual(JSON.parse(revokeRequest.init.body), { reason: 'evolution.promotionRevokeReason' })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('evolution settings builds a human decision from the exact reviewed confirmations', () => {
  const confirmations = {
    candidateContentSha256: 'a'.repeat(64),
    replayRunFingerprint: 'b'.repeat(64),
    evaluationFingerprint: 'c'.repeat(64),
    rollbackBaselineSha256: 'd'.repeat(64),
  }
  const input = buildEvolutionDecisionInput({ evaluationId: 'eval-1', confirmations }, 'approved', ' Reviewed replay evidence ')
  assert.deepEqual(input, {
    evaluationId: 'eval-1',
    decision: 'approved',
    reason: 'Reviewed replay evidence',
    confirmations,
  })
  assert.equal(buildEvolutionDecisionInput({ evaluationId: 'eval-1', confirmations }, 'approved', '  '), null)
})

test('evolution workbench copy is complete in both supported languages', () => {
  for (const language of ['zh', 'en']) {
    assert.equal(typeof translations[language].evolution.title, 'string')
    assert.equal(typeof translations[language].evolution.unsupportedBoundary, 'string')
    assert.equal(typeof translations[language].evolution.rollbackPolicyReason, 'string')
    assert.equal(typeof translations[language].evolution.workflow, 'string')
    assert.equal(typeof translations[language].evolution.workflowBoundary, 'string')
    assert.equal(typeof translations[language].evolution.candidateProvider, 'string')
    assert.equal(typeof translations[language].evolution.replayProvider, 'string')
    assert.equal(typeof translations[language].evolution.evaluatorProvider, 'string')
    assert.equal(typeof translations[language].evolution.evaluatorModel, 'string')
    assert.equal(typeof translations[language].evolution.state.rolled_back, 'string')
    assert.equal(typeof translations[language].evolution.promotions, 'string')
    assert.equal(typeof translations[language].evolution.confirmPromotionFingerprints, 'string')
    assert.equal(typeof translations[language].evolution.revokePromotion, 'string')
    assert.equal(typeof translations[language].evolution.autopilot, 'string')
    assert.equal(typeof translations[language].evolution.autopilotMissingModels, 'string')
    assert.equal(typeof translations[language].evolution.autoState.failed, 'string')
    assert.equal(typeof translations[language].evolution.advancedAudit, 'string')
  }
})

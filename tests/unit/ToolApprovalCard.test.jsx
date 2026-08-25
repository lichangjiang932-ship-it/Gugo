import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ToolApprovalCard from '../../src/components/ToolApprovalCard.jsx'
import PermissionModeSwitcher from '../../src/components/PermissionModeSwitcher.jsx'
import { ApprovalCard } from '../../src/pages/ApprovalsInbox.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import useChatApprovals from '../../src/pages/ChatSplit/useChatApprovals.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

async function renderInto(dom, node) {
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => { root.render(<I18nProvider>{node}</I18nProvider>) })
  return {
    html: () => dom.window.document.getElementById('root').innerHTML,
    cleanup: async () => { await act(async () => root.unmount()) },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function renderChatApprovalsHook(dom) {
  const root = createRoot(dom.window.document.getElementById('root'))
  let latest
  function Harness() {
    latest = useChatApprovals({
      setWorkbenchMessage: () => {},
      toast: { info: () => {}, error: () => {} },
      t: (key) => key,
    })
    return null
  }
  await act(async () => { root.render(<Harness />) })
  return { root, latest: () => latest }
}

function installApprovalFetchRecorder({ decideStatus = 200 } = {}) {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url) === '/api/approvals/settings') {
      return jsonResponse({ mode: 'normal', rememberedTools: [], rememberedGrants: [] })
    }
    if (String(url).endsWith('/decide') && decideStatus !== 200) {
      return jsonResponse({ error: { code: 'APPROVAL_DECISION_FAILED', message: 'approval service unavailable' } }, decideStatus)
    }
    return jsonResponse({ ok: true })
  }
  return {
    decisions: () => requests
      .filter((request) => request.url.endsWith('/decide'))
      .map((request) => JSON.parse(String(request.init.body || '{}'))),
    restore: () => { globalThis.fetch = originalFetch },
  }
}

const SHELL_REQUEST = {
  name: 'bash_exec',
  args: { command: 'rm -rf /tmp/x' },
  risk: 'high',
  reason: '执行 shell 命令',
  preview: null,
}

const FILE_REQUEST = {
  name: 'write_file',
  args: { path: 'demo.txt', content: 'hello' },
  risk: 'medium',
  metadataSource: 'declared',
  reason: '写入文件',
  preview: null,
}

test('shell approval never offers a standing-rule action', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, <ToolApprovalCard open request={SHELL_REQUEST} onDecide={() => {}} busy={false} />)
  const html = view.html()
  assert.match(html, /bash_exec/)
  assert.match(html, /rm -rf/)
  assert.match(html, /允许一次/)
  assert.doesNotMatch(html, /总是允许/)
  assert.match(html, /拒绝/)
  assert.equal(
    dom.window.document.querySelector('[data-testid="tool-risk-source"]').textContent.trim(),
    '风险来源: 兼容兜底',
  )
  const actionGroup = dom.window.document.querySelector('[data-testid="tool-approval-actions"]')
  assert.ok(actionGroup.classList.contains('ml-auto'))
  assert.ok(actionGroup.classList.contains('flex-wrap'))
  assert.ok(actionGroup.classList.contains('justify-end'))
  assert.equal(actionGroup.querySelectorAll('button').length, 2)
  await view.cleanup()
})

test('run_command approval shows env key names and never offers a standing rule', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, (
    <ToolApprovalCard
      open
      busy={false}
      onDecide={() => {}}
      request={{
        name: 'run_command',
        args: { command: 'npm publish', env_keys: ['NPM_TOKEN'] },
        risk: 'high',
        reason: 'credential-aware command',
      }}
    />
  ))
  const html = view.html()
  assert.match(html, /run_command/)
  assert.match(html, /npm publish/)
  assert.match(html, /NPM_TOKEN/)
  assert.doesNotMatch(html, /always allow/i)
  await view.cleanup()
})

test('ToolApprovalCard renders an apply_patch diff preview', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, (
    <ToolApprovalCard
      open
      busy={false}
      onDecide={() => {}}
      request={{
        name: 'apply_patch',
        args: { patch: 'x' },
        risk: 'medium',
        reason: '原子修改 1 个文件',
        preview: [{ path: 'demo.txt', op: 'add', preview: '+hello\n-world' }],
      }}
    />
  ))
  assert.match(view.html(), /demo\.txt/)
  await view.cleanup()
})

test('non-shell approval actions return one-time, standing-rule, and deny decisions', async () => {
  const dom = setupDom()
  const decisions = []
  const view = await renderInto(dom, (
    <ToolApprovalCard open request={FILE_REQUEST} busy={false} onDecide={(decision) => decisions.push(decision)} />
  ))
  const buttons = [...dom.window.document.querySelectorAll('button')]
  const byText = (text) => buttons.find((button) => button.textContent.includes(text))
  const actionGroup = dom.window.document.querySelector('[data-testid="tool-approval-actions"]')
  const hint = dom.window.document.querySelector('[data-testid="tool-approval-hint"]')
  assert.equal(
    dom.window.document.querySelector('[data-testid="tool-risk-source"]').textContent.trim(),
    '风险来源: 显式声明',
  )
  assert.equal(hint.parentElement.firstElementChild, hint)
  assert.equal(actionGroup.parentElement.lastElementChild, actionGroup)
  assert.ok(hint.classList.contains('mr-auto'))
  assert.ok(actionGroup.classList.contains('ml-auto'))
  assert.ok(actionGroup.classList.contains('flex-wrap'))
  assert.ok(actionGroup.classList.contains('justify-end'))
  for (const label of ['允许一次', '总是允许', '拒绝']) {
    const button = byText(label)
    assert.ok(button, `找不到按钮: ${label}`)
    assert.equal(button.closest('[data-testid="tool-approval-actions"]'), actionGroup)
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  }
  assert.deepEqual(decisions, [
    { approved: true },
    { approved: true, remember: true },
    { approved: false },
  ])
  await view.cleanup()
})

test('ToolApprovalCard renders nothing while closed', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, <ToolApprovalCard open={false} request={null} onDecide={() => {}} />)
  assert.equal(view.html(), '')
  await view.cleanup()
})

test('ToolApprovalCard tolerates a request with optional fields missing', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, (
    <ToolApprovalCard open request={{ name: 'mystery_tool' }} onDecide={() => {}} busy={false} />
  ))
  assert.match(view.html(), /mystery_tool/)
  assert.match(view.html(), /兼容兜底/)
  await view.cleanup()
})

test('approval inbox card displays the persisted metadata source', async () => {
  const dom = setupDom()
  const labels = {
    'approvals.risk.medium': '中风险',
    'approvals.source.label': '风险来源',
    'approvals.source.declared': '显式声明',
    'approvals.origin.job': '后台任务',
  }
  const view = await renderInto(dom, (
    <ApprovalCard
      approval={{
        id: 'approval-1', toolName: 'write_file', args: { path: 'demo.txt' },
        risk: 'medium', metadataSource: 'declared', origin: 'job', createdAt: 1,
      }}
      busy={false}
      onDecide={() => {}}
      t={(key) => labels[key] || key}
    />
  ))
  assert.equal(
    dom.window.document.querySelector('[data-testid="approval-risk-source"]').textContent.trim(),
    '风险来源: 显式声明',
  )
  await view.cleanup()
})

test('PermissionModeSwitcher renders every supported mode', async () => {
  for (const mode of ['normal', 'acceptEdits', 'plan', 'bypass']) {
    const dom = setupDom()
    const view = await renderInto(dom, <PermissionModeSwitcher mode={mode} onChange={() => {}} />)
    assert.ok(view.html().length > 0, `${mode} rendered empty`)
    await view.cleanup()
  }
})

test('PermissionModeSwitcher can select another mode', async () => {
  const dom = setupDom()
  const picked = []
  const view = await renderInto(dom, <PermissionModeSwitcher mode="normal" onChange={(mode) => picked.push(mode)} />)
  const trigger = dom.window.document.querySelector('button')
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const planButton = [...dom.window.document.querySelectorAll('button')]
    .find((button) => button.textContent.includes('计划模式'))
  assert.ok(planButton)
  await act(async () => { planButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(picked, ['plan'])
  await view.cleanup()
})

test('PermissionModeSwitcher tolerates an unknown mode', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, <PermissionModeSwitcher mode="unknown" onChange={() => {}} />)
  assert.ok(view.html().length > 0)
  await view.cleanup()
})

test('replayed approval.required reuses one pending decision without submitting deny', async () => {
  const dom = setupDom()
  const recorder = installApprovalFetchRecorder()
  const view = await renderChatApprovalsHook(dom)
  const request = { id: 'approval-replayed', name: 'bash_exec', args: { command: 'python fill.py' } }
  const owner = { sessionId: 'session-1', turnId: 'turn-1' }
  try {
    let first
    let replay
    await act(async () => {
      first = view.latest().requestServerToolApproval(request, owner)
      replay = view.latest().requestServerToolApproval(request, owner)
    })
    assert.equal(replay, first)
    assert.deepEqual(recorder.decisions(), [])

    await act(async () => {
      view.latest().resolveToolApproval({ approved: true })
      await Promise.all([first, replay])
    })
    assert.deepEqual(recorder.decisions(), [{ decision: 'approve' }])
  } finally {
    await act(async () => view.root.unmount())
    recorder.restore()
    dom.window.close()
  }
})

test('unmounting a pending chat approval does not fabricate a user denial', async () => {
  const dom = setupDom()
  const recorder = installApprovalFetchRecorder()
  const view = await renderChatApprovalsHook(dom)
  try {
    let pending
    await act(async () => {
      pending = view.latest().requestServerToolApproval(
        { id: 'approval-unmount', name: 'run_test', args: { command: 'npm test' } },
        { sessionId: 'session-2', turnId: 'turn-2' },
      )
    })
    const settled = pending.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    )
    await act(async () => view.root.unmount())
    const outcome = await settled
    assert.equal(outcome.resolved, undefined)
    assert.equal(outcome.error?.name, 'AbortError')
    assert.equal(outcome.error?.code, 'APPROVAL_PRESENTATION_CLOSED')
    assert.deepEqual(recorder.decisions(), [])
  } finally {
    recorder.restore()
    dom.window.close()
  }
})

test('a failed approval POST rejects and releases the request without fabricating deny', async () => {
  const dom = setupDom()
  const recorder = installApprovalFetchRecorder({ decideStatus: 503 })
  const view = await renderChatApprovalsHook(dom)
  const request = { id: 'approval-post-failure', name: 'bash_exec', args: { command: 'python fill.py' } }
  const owner = { sessionId: 'session-post-failure', turnId: 'turn-post-failure' }
  try {
    let pending
    await act(async () => {
      pending = view.latest().requestServerToolApproval(request, owner)
    })
    const settled = pending.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    )
    await act(async () => {
      assert.equal(view.latest().resolveToolApproval({ approved: true }), true)
      await settled
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    const outcome = await settled
    assert.equal(outcome.resolved, undefined)
    assert.equal(outcome.error?.code, 'APPROVAL_DECISION_FAILED')
    assert.equal(outcome.error?.status, 503)
    assert.deepEqual(recorder.decisions(), [{ decision: 'approve' }])
    assert.equal(view.latest().toolApproval.open, false)

    // A replay can own a fresh waiter after the failed POST. The stale Promise
    // must not keep the session locked or swallow the durable approval event.
    let replay
    await act(async () => {
      replay = view.latest().requestServerToolApproval(request, owner)
    })
    assert.notEqual(replay, pending)
    assert.equal(view.latest().toolApproval.request.id, request.id)
    const replaySettled = replay.catch((error) => error)
    await act(async () => view.root.unmount())
    assert.equal((await replaySettled).code, 'APPROVAL_PRESENTATION_CLOSED')
    assert.deepEqual(recorder.decisions(), [{ decision: 'approve' }])
  } finally {
    recorder.restore()
    dom.window.close()
  }
})

test('owner cleanup settles a pending approval locally without submitting deny', async () => {
  const dom = setupDom()
  const recorder = installApprovalFetchRecorder()
  const view = await renderChatApprovalsHook(dom)
  const owner = { sessionId: 'session-owner-clear', turnId: 'turn-owner-clear' }
  try {
    let pending
    await act(async () => {
      pending = view.latest().requestServerToolApproval(
        { id: 'approval-owner-clear', name: 'write_file', args: { path: 'result.txt' } },
        owner,
      )
    })
    const settled = pending.catch((error) => error)
    await act(async () => {
      assert.equal(view.latest().clearToolApprovalForOwner(owner), true)
      await settled
    })
    const error = await settled
    assert.equal(error.name, 'AbortError')
    assert.equal(error.code, 'APPROVAL_PRESENTATION_CLOSED')
    assert.equal(view.latest().toolApproval.open, false)
    assert.deepEqual(recorder.decisions(), [])
  } finally {
    await act(async () => view.root.unmount())
    recorder.restore()
    dom.window.close()
  }
})

test('different chat approvals wait in order and never deny the active request', async () => {
  const dom = setupDom()
  const recorder = installApprovalFetchRecorder()
  const view = await renderChatApprovalsHook(dom)
  const owner = { sessionId: 'session-3', turnId: 'turn-3' }
  try {
    let first
    let second
    await act(async () => {
      first = view.latest().requestServerToolApproval(
        { id: 'approval-first', name: 'bash_exec', args: { command: 'python write.py' } },
        owner,
      )
      second = view.latest().requestServerToolApproval(
        { id: 'approval-second', name: 'run_test', args: { command: 'python verify.py' } },
        owner,
      )
    })
    assert.equal(view.latest().toolApproval.request.id, 'approval-first')
    assert.deepEqual(recorder.decisions(), [])

    await act(async () => {
      view.latest().resolveToolApproval({ approved: true })
      await first
      await Promise.resolve()
    })
    assert.equal(view.latest().toolApproval.request.id, 'approval-second')
    assert.deepEqual(recorder.decisions(), [{ decision: 'approve' }])

    await act(async () => {
      view.latest().resolveToolApproval({ approved: true })
      await second
    })
    assert.deepEqual(recorder.decisions(), [
      { decision: 'approve' },
      { decision: 'approve' },
    ])
  } finally {
    await act(async () => view.root.unmount())
    recorder.restore()
    dom.window.close()
  }
})

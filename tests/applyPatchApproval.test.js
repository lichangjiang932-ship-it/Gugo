import test from 'node:test'
import assert from 'node:assert/strict'

import { executeToolCall, setCachedApprovalSettings } from '../src/lib/tools/index.js'

/**
 * apply_patch 的审批以前走一条它专属的路径(window.__applyPatchApproval +
 * localStorage 的 apply_patch.auto_approve 后门),其他有副作用的工具则完全没门控。
 * 现在统一收敛到 executeToolCall 里的审批闸口 window.__toolApprovalGate,
 * 支持「允许一次 / 总是允许 / 拒绝」,并覆盖所有工具。
 */

function makeApplyPatchCall() {
  return {
    name: 'apply_patch',
    arguments: JSON.stringify({
      patch: '*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch',
    }),
  }
}

/** 装一个假的审批 UI,记录它被问了几次、拿到什么。 */
function installGate({ decision }) {
  const seen = { calls: 0, last: null }
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    __toolApprovalGate: async (request) => {
      seen.calls += 1
      seen.last = request
      return decision
    },
  }
  return seen
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 })
}

const DRY_RUN_BODY = {
  ok: true,
  dry_run: true,
  total: 1,
  changes: [{ path: 'demo.txt', op: 'add', stats: { added: 1, removed: 0 }, preview: '+hello' }],
}

async function withStubs(fn, { fetchImpl }) {
  const oldFetch = globalThis.fetch
  const oldWindow = globalThis.window
  globalThis.fetch = fetchImpl
  try {
    return await fn()
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
    setCachedApprovalSettings({ mode: 'normal', rememberedTools: [] })
  }
}

test('apply_patch 批准后:先 dry_run 预览再真正落盘', async () => {
  setCachedApprovalSettings({ mode: 'normal', rememberedTools: [] })
  const gate = installGate({ decision: { approved: true } })
  const requests = []
  await withStubs(async () => {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, true)
    assert.equal(gate.calls, 1, '应该问了用户一次')
    // 闸口拿到 diff 预览,用户才能看清要改什么
    assert.deepEqual(gate.last.preview, DRY_RUN_BODY.changes)
    assert.equal(gate.last.name, 'apply_patch')
    // 最后一次必须是真正落盘
    assert.equal(requests[requests.length - 1].dry_run, false)
    assert.equal(JSON.parse(result.content).dry_run, false)
  }, {
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/tools/code/apply-patch')
      const body = JSON.parse(init.body)
      requests.push(body)
      return body.dry_run
        ? jsonResponse(DRY_RUN_BODY)
        : jsonResponse({ ok: true, dry_run: false, total: 1, changes: [{ path: 'demo.txt', op: 'add' }] })
    },
  })
})

test('apply_patch 被拒绝:不落盘,并把拒绝结果回给模型', async () => {
  setCachedApprovalSettings({ mode: 'normal', rememberedTools: [] })
  const gate = installGate({ decision: { approved: false } })
  const requests = []
  await withStubs(async () => {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, false)
    assert.equal(gate.calls, 1)
    assert.equal(JSON.parse(result.content).rejected, true)
    // 关键:没有任何 dry_run:false 的请求,即真的没落盘
    assert.ok(requests.every((r) => r.dry_run === true), '被拒绝时不得写入')
  }, {
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body))
      return jsonResponse(DRY_RUN_BODY)
    },
  })
})

test('「总是允许」之后同一个工具不再询问', async () => {
  // 模拟用户之前点过「总是允许 apply_patch」
  setCachedApprovalSettings({ mode: 'normal', rememberedTools: ['apply_patch'] })
  const gate = installGate({ decision: { approved: false } })
  await withStubs(async () => {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(gate.calls, 0, '记住过的工具不该再弹审批')
    assert.equal(result.ok, true)
  }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      return body.dry_run
        ? jsonResponse(DRY_RUN_BODY)
        : jsonResponse({ ok: true, dry_run: false, total: 1 })
    },
  })
})

test('acceptEdits 档位:改文件类工具直接放行', async () => {
  setCachedApprovalSettings({ mode: 'acceptEdits', rememberedTools: [] })
  const gate = installGate({ decision: { approved: false } })
  await withStubs(async () => {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(gate.calls, 0, 'acceptEdits 下编辑类工具不该问')
    assert.equal(result.ok, true)
  }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      return body.dry_run ? jsonResponse(DRY_RUN_BODY) : jsonResponse({ ok: true, dry_run: false })
    },
  })
})

test('plan 档位:写操作直接拒绝,连问都不问', async () => {
  setCachedApprovalSettings({ mode: 'plan', rememberedTools: [] })
  const gate = installGate({ decision: { approved: true } })
  let touched = false
  await withStubs(async () => {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(gate.calls, 0, '计划模式是拒绝,不是询问')
    assert.equal(result.ok, false)
    assert.equal(JSON.parse(result.content).denied, true)
    assert.equal(touched, false, '计划模式下不得发起任何写请求')
  }, {
    fetchImpl: async () => {
      touched = true
      return jsonResponse(DRY_RUN_BODY)
    },
  })
})

test('没有审批 UI 时保守拒绝,不静默放行', async () => {
  setCachedApprovalSettings({ mode: 'normal', rememberedTools: [] })
  // window 上没有 __toolApprovalGate
  globalThis.window = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }
  let wrote = false
  await withStubs(async () => {
    const result = await executeToolCall(makeApplyPatchCall(), { maxRetries: 0 })
    assert.equal(result.ok, false)
    assert.equal(wrote, false, '没有 UI 可问时绝不能直接执行')
  }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.dry_run === false) wrote = true
      return jsonResponse(DRY_RUN_BODY)
    },
  })
})

test('bash_exec 这类以前完全没门控的工具现在也要审批', async () => {
  setCachedApprovalSettings({ mode: 'normal', rememberedTools: [] })
  const gate = installGate({ decision: { approved: false } })
  let executed = false
  await withStubs(async () => {
    const result = await executeToolCall(
      { name: 'bash_exec', arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }) },
      { maxRetries: 0 },
    )
    assert.equal(gate.calls, 1, 'bash_exec 必须过审批')
    assert.equal(gate.last.risk, 'high')
    assert.equal(result.ok, false)
    assert.equal(executed, false)
  }, {
    fetchImpl: async () => {
      executed = true
      return jsonResponse({ ok: true, stdout: '' })
    },
  })
})

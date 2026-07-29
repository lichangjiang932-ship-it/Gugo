import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ToolApprovalCard from '../../src/components/ToolApprovalCard.jsx'
import PermissionModeSwitcher from '../../src/components/PermissionModeSwitcher.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

/**
 * 这两个组件是审批改版的主界面。以前 tests/unit/*.jsx 根本没被
 * scripts/run-tests.js 收集(它只匹配 .test.js),所以任何渲染期就炸的
 * 组件都能一路绿灯合进去 —— 这组用例就是补这个洞。
 */

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
    root,
    html: () => dom.window.document.getElementById('root').innerHTML,
    cleanup: async () => { await act(async () => root.unmount()) },
  }
}

const REQUEST = {
  name: 'bash_exec',
  args: { command: 'rm -rf /tmp/x' },
  risk: 'high',
  reason: '执行 shell 命令',
  preview: null,
}

test('ToolApprovalCard 能渲染并显示工具名、风险与三个操作', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, <ToolApprovalCard open request={REQUEST} onDecide={() => {}} busy={false} />)
  const html = view.html()
  assert.match(html, /bash_exec/)
  assert.match(html, /rm -rf/)
  // 三个按钮都在 —— 「总是允许」是本次改版的核心
  assert.match(html, /允许一次/)
  assert.match(html, /总是允许/)
  assert.match(html, /拒绝/)
  await view.cleanup()
})

test('ToolApprovalCard 渲染 apply_patch 的 diff 预览', async () => {
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

test('ToolApprovalCard 三个决策按钮回传正确结果', async () => {
  const dom = setupDom()
  const decisions = []
  const view = await renderInto(dom, (
    <ToolApprovalCard open request={REQUEST} busy={false} onDecide={(d) => decisions.push(d)} />
  ))
  const buttons = [...dom.window.document.querySelectorAll('button')]
  const byText = (text) => buttons.find((b) => b.textContent.includes(text))
  for (const label of ['允许一次', '总是允许', '拒绝']) {
    const btn = byText(label)
    assert.ok(btn, `找不到按钮: ${label}`)
    await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  }
  assert.deepEqual(decisions, [
    { approved: true },
    { approved: true, remember: true },
    { approved: false },
  ])
  await view.cleanup()
})

test('ToolApprovalCard 关闭态不渲染任何东西', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, <ToolApprovalCard open={false} request={null} onDecide={() => {}} />)
  assert.equal(view.html(), '')
  await view.cleanup()
})

test('ToolApprovalCard 对缺字段的 request 不崩', async () => {
  const dom = setupDom()
  // risk/reason/args 都缺 —— 后端换了字段名也不该白屏
  const view = await renderInto(dom, (
    <ToolApprovalCard open request={{ name: 'mystery_tool' }} onDecide={() => {}} busy={false} />
  ))
  assert.match(view.html(), /mystery_tool/)
  await view.cleanup()
})

test('PermissionModeSwitcher 四档都能渲染', async () => {
  for (const mode of ['normal', 'acceptEdits', 'plan', 'bypass']) {
    const dom = setupDom()
    const view = await renderInto(dom, <PermissionModeSwitcher mode={mode} onChange={() => {}} />)
    assert.ok(view.html().length > 0, `${mode} 档位渲染为空`)
    await view.cleanup()
  }
})

test('PermissionModeSwitcher 展开后能选到别的档位', async () => {
  const dom = setupDom()
  const picked = []
  const view = await renderInto(dom, <PermissionModeSwitcher mode="normal" onChange={(m) => picked.push(m)} />)
  const trigger = dom.window.document.querySelector('button')
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const items = [...dom.window.document.querySelectorAll('button')]
  const planBtn = items.find((b) => b.textContent.includes('计划模式'))
  assert.ok(planBtn, '展开后应能看到计划模式')
  await act(async () => { planBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(picked, ['plan'])
  await view.cleanup()
})

test('PermissionModeSwitcher 传了未知档位也不崩', async () => {
  const dom = setupDom()
  const view = await renderInto(dom, <PermissionModeSwitcher mode="不存在的档位" onChange={() => {}} />)
  assert.ok(view.html().length > 0)
  await view.cleanup()
})

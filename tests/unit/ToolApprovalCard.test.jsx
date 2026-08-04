import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ToolApprovalCard from '../../src/components/ToolApprovalCard.jsx'
import PermissionModeSwitcher from '../../src/components/PermissionModeSwitcher.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

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
  for (const label of ['允许一次', '总是允许', '拒绝']) {
    const button = byText(label)
    assert.ok(button, `找不到按钮: ${label}`)
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

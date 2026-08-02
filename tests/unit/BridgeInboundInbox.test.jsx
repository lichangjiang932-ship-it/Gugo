import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { BridgeInboundInbox } from '../../src/pages/AccessView.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/access?bridgeParkingId=parked-1',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

const labels = {
  'access.inboundInboxTitle': '陌生消息收件箱',
  'access.inboundInboxHint': '陌生联系人不会直接触发 Agent。',
  'access.inboundEmpty': '没有等待处理的陌生消息。',
  'access.allowAndDeliver': '允许并投递',
  'access.rejectSender': '拒绝联系人',
  'access.unknownSender': '未知联系人',
  'access.delivering': '投递中…',
  'access.attachmentMessage': '包含 {count} 个附件',
}
const t = (key) => labels[key] || key

async function click(dom, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

test('陌生消息 Inbox 展示净化预览、高亮目标并触发允许或拒绝', async () => {
  const dom = setupDom()
  const allowed = []
  const rejected = []
  const messages = [{
    id: 'parked-1',
    provider: 'feishu',
    externalUserId: 'external-1',
    senderName: '新联系人',
    payload: { text: '请帮我整理这份资料', attachments: [] },
    createdAt: 1_700_000_000_000,
  }]
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => {
      root.render(
        <BridgeInboundInbox
          messages={messages}
          busyId=""
          highlightedId="parked-1"
          onAllow={(id) => allowed.push(id)}
          onReject={(id) => rejected.push(id)}
          t={t}
        />,
      )
    })

    const card = rootElement.querySelector('[data-testid="bridge-parking-parked-1"]')
    assert.ok(card)
    assert.match(card.className, /ring-2/)
    assert.match(rootElement.textContent, /新联系人/)
    assert.match(rootElement.textContent, /请帮我整理这份资料/)

    const buttons = [...card.querySelectorAll('button')]
    await click(dom, buttons.find((button) => button.textContent.includes('允许并投递')))
    await click(dom, buttons.find((button) => button.textContent.includes('拒绝联系人')))
    assert.deepEqual(allowed, ['parked-1'])
    assert.deepEqual(rejected, ['parked-1'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('陌生消息 Inbox 在空状态和投递中禁用操作', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<BridgeInboundInbox messages={[]} busyId="" highlightedId="" onAllow={() => {}} onReject={() => {}} t={t} />)
    })
    assert.match(rootElement.textContent, /没有等待处理的陌生消息/)

    await act(async () => {
      root.render(
        <BridgeInboundInbox
          messages={[{ id: 'parked-2', provider: 'wechat', payload: { attachments: [{ type: 'image' }] }, createdAt: 'invalid' }]}
          busyId="parked-2"
          highlightedId=""
          onAllow={() => {}}
          onReject={() => {}}
          t={t}
        />,
      )
    })
    assert.match(rootElement.textContent, /未知联系人/)
    assert.match(rootElement.textContent, /包含 1 个附件/)
    assert.match(rootElement.textContent, /投递中/)
    assert.ok([...rootElement.querySelectorAll('button')].every((button) => button.disabled))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

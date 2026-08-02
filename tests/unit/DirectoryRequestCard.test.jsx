import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DirectoryRequestCard } from '../../src/pages/TaskRunPanel.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/tasks',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

const labels = {
  'taskSteering.directoryRequestTitle': '任务需要目录授权',
  'taskSteering.directoryPathPlaceholder': '目录路径',
  'taskSteering.directoryAccessMode': '访问模式',
  'taskSteering.directoryReadOnly': '仅读取',
  'taskSteering.directoryReadWrite': '读取和修改',
  'taskSteering.authorizeDirectory': '授权此路径',
  'taskSteering.chooseDirectory': '选择目录',
  'taskSteering.directorySecurityHint': '只有明确选择的目录会被授权。',
}
const t = (key) => labels[key] || key

async function click(dom, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

test('目录请求卡保留建议路径、最小权限并区分手工授权与系统选择器', async () => {
  const dom = setupDom()
  const decisions = []
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <DirectoryRequestCard
          request={{ purpose: '读取季度报告', suggested_path: 'D:\\Reports', access_mode: 'read_only' }}
          busy=""
          onAuthorize={(value) => decisions.push(value)}
          t={t}
        />,
      )
    })

    const input = rootElement.querySelector('input')
    const select = rootElement.querySelector('select')
    const buttons = [...rootElement.querySelectorAll('button')]
    assert.equal(input.value, 'D:\\Reports')
    assert.equal(select.value, 'read_only')
    assert.match(rootElement.textContent, /读取季度报告/)

    await click(dom, buttons.find((button) => button.textContent.includes('授权此路径')))
    await click(dom, buttons.find((button) => button.textContent.includes('选择目录')))
    assert.deepEqual(decisions, [
      { path: 'D:\\Reports', accessMode: 'read_only', usePicker: false },
      { path: 'D:\\Reports', accessMode: 'read_only', usePicker: true },
    ])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

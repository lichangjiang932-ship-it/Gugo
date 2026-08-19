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
  'taskSteering.directoryBrowserSelectCurrent': '选择当前目录',
  'localFiles.authorizationLifetime': '授权保留时间',
  'localFiles.authorizationSession': '仅本会话（服务重启后失效）',
  'localFiles.authorizationPersistent': '永久记住',
}
const t = (key) => labels[key] || key

async function click(dom, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

test('目录请求卡保留建议路径、最小权限并通过内联浏览更新授权路径', async () => {
  const dom = setupDom()
  const decisions = []
  const browsedPaths = []
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <DirectoryRequestCard
          request={{ purpose: '读取季度报告', suggested_path: 'D:\\Reports', access_mode: 'read_only' }}
          busy=""
          onAuthorize={(value) => decisions.push(value)}
          browseDirectories={async (path) => {
            browsedPaths.push(path)
            return {
              directory: {
                currentPath: path,
                parentPath: 'D:\\',
                projectDirectory: 'D:\\Project',
                defaultOutputDirectory: 'D:\\Output',
                entries: path === 'D:\\Reports'
                  ? [{ name: 'Archive', path: 'D:\\Reports\\Archive' }]
                  : [],
              },
            }
          }}
          t={t}
        />,
      )
    })

    const input = rootElement.querySelector('input')
    const [accessModeSelect, authorizationScopeSelect] = rootElement.querySelectorAll('select')
    const buttons = [...rootElement.querySelectorAll('button')]
    assert.equal(input.value, 'D:\\Reports')
    assert.equal(accessModeSelect.value, 'read_only')
    assert.equal(authorizationScopeSelect.value, 'session')
    assert.equal(authorizationScopeSelect.getAttribute('aria-label'), '授权保留时间')
    assert.deepEqual(
      [...authorizationScopeSelect.options].map((option) => option.textContent),
      ['仅本会话（服务重启后失效）', '永久记住'],
    )
    assert.match(rootElement.textContent, /读取季度报告/)

    await click(dom, buttons.find((button) => button.textContent.includes('授权此路径')))
    await click(dom, buttons.find((button) => button.textContent.includes('选择目录')))
    assert.ok(rootElement.querySelector('[data-testid="inline-directory-browser"]'))
    assert.deepEqual(decisions, [{
      path: 'D:\\Reports',
      accessMode: 'read_only',
      authorizationScope: 'session',
    }])

    const archiveButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Archive'))
    await click(dom, archiveButton)
    const selectCurrentButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('选择当前目录'))
    await click(dom, selectCurrentButton)

    assert.equal(input.value, 'D:\\Reports\\Archive')
    assert.equal(rootElement.querySelector('[data-testid="inline-directory-browser"]'), null)
    await click(dom, [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('授权此路径')))
    assert.deepEqual(decisions, [
      { path: 'D:\\Reports', accessMode: 'read_only', authorizationScope: 'session' },
      { path: 'D:\\Reports\\Archive', accessMode: 'read_only', authorizationScope: 'session' },
    ])
    assert.deepEqual(browsedPaths, ['D:\\Reports', 'D:\\Reports\\Archive'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

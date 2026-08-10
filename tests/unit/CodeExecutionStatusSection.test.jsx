import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { CodeExecutionStatusSection } from '../../src/pages/permissions/PermissionSections.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/permissions',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const copy = {
  'localFiles.codeExecutionTitle': '代码执行运行时',
  'localFiles.codeExecutionHint': '仅明确授权的读写目录可执行代码。',
  'localFiles.codeExecutionRuntime': '后端运行时',
  'localFiles.codeExecutionToolGate': '用户工具 Gate',
  'localFiles.codeExecutionWritableDirectories': '可执行读写目录',
  'localFiles.codeExecutionEnabled': '已启用',
  'localFiles.codeExecutionDisabled': '已关闭',
  'localFiles.codeExecutionLoading': '检查中',
  'localFiles.codeExecutionUnknown': '未报告',
  'localFiles.codeExecutionChecking': '正在读取代码执行状态…',
  'localFiles.codeExecutionRuntimeUnknown': '后端未报告代码执行状态，请重启服务。',
  'localFiles.codeExecutionRuntimeBlocked': '当前部署已关闭本地代码执行。',
  'localFiles.codeExecutionToolBlocked': 'bash_exec 已在权限中心关闭。',
  'localFiles.codeExecutionNeedsWritableDirectory': '请先给目标目录授予 read_write 权限。',
  'localFiles.codeExecutionReady': '代码执行已就绪，可在 {count} 个目录中运行命令。',
}

function t(key, variables = {}) {
  return String(copy[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ''))
}

function controller({ runtimeEnabled = true, toolEnabled = true, grants = [] } = {}) {
  return {
    localFiles: {
      runtime: { localCodeExecutionEnabled: runtimeEnabled },
      grants,
    },
    isToolEnabled: (id) => id === 'bash_exec' && toolEnabled,
  }
}

test('code execution status distinguishes runtime, tool gate, and writable-directory readiness', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(
      <CodeExecutionStatusSection
        controller={controller({
          grants: [
            { resourceType: 'directory', accessMode: 'read_write', available: true },
            { resourceType: 'file', accessMode: 'read_write', available: true },
            { resourceType: 'directory', accessMode: 'read_only', available: true },
          ],
        })}
        t={t}
      />,
    ))
    const status = rootElement.querySelector('[data-testid="code-execution-status"]')
    assert.ok(status)
    assert.match(status.textContent, /代码执行已就绪，可在 1 个目录中运行命令/)
    assert.match(status.textContent, /可执行读写目录1/)

    await act(async () => root.render(
      <CodeExecutionStatusSection controller={controller({ runtimeEnabled: false })} t={t} />,
    ))
    assert.match(status.textContent, /当前部署已关闭本地代码执行/)

    await act(async () => root.render(
      <CodeExecutionStatusSection controller={controller({ toolEnabled: false })} t={t} />,
    ))
    assert.match(status.textContent, /bash_exec 已在权限中心关闭/)

    await act(async () => root.render(
      <CodeExecutionStatusSection controller={controller()} t={t} />,
    ))
    assert.match(status.textContent, /请先给目标目录授予 read_write 权限/)

    await act(async () => root.render(
      <CodeExecutionStatusSection
        controller={{ localFiles: { grants: [] }, isToolEnabled: () => true }}
        t={t}
      />,
    ))
    assert.match(status.textContent, /后端未报告代码执行状态，请重启服务/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

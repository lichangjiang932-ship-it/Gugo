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
  'localFiles.codeExecutionHint': '宿主 Shell 与受限 run_code 分别检查。',
  'localFiles.codeExecutionShellRuntime': '宿主命令运行时',
  'localFiles.codeExecutionShellToolGate': 'bash_exec 用户 Gate',
  'localFiles.codeExecutionRunCodeRuntime': '受限计算运行时',
  'localFiles.codeExecutionRunCodeToolGate': 'run_code 用户 Gate',
  'localFiles.codeExecutionWritableDirectories': '可执行读写目录',
  'localFiles.codeExecutionEnabled': '已启用',
  'localFiles.codeExecutionDisabled': '已关闭',
  'localFiles.codeExecutionLoading': '检查中',
  'localFiles.codeExecutionUnknown': '未报告',
  'localFiles.codeExecutionChecking': '正在读取宿主命令状态…',
  'localFiles.codeExecutionRuntimeUnknown': '后端未报告宿主命令状态，请重启服务。',
  'localFiles.codeExecutionRuntimeBlocked': '当前部署已关闭宿主命令执行。',
  'localFiles.codeExecutionToolBlocked': 'bash_exec 已在权限中心关闭。',
  'localFiles.codeExecutionNeedsWritableDirectory': '请先给目标目录授予 read_write 权限。',
  'localFiles.codeExecutionReady': '宿主命令已就绪，可在 {count} 个目录中运行。',
  'localFiles.codeExecutionRunCodeChecking': '正在读取受限 run_code 状态…',
  'localFiles.codeExecutionRunCodeRuntimeUnknown': '后端未报告受限 run_code 状态，请重启服务。',
  'localFiles.codeExecutionRunCodeRuntimeBlocked': '当前部署已关闭受限 run_code。',
  'localFiles.codeExecutionRunCodeToolBlocked': 'run_code 已在权限中心关闭。',
  'localFiles.codeExecutionRunCodeReady': '受限 run_code 已就绪，不需要目录权限。',
}

function t(key, variables = {}) {
  return String(copy[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ''))
}

function controller({
  shellRuntimeEnabled = true,
  runCodeRuntimeEnabled = true,
  shellToolEnabled = true,
  runCodeToolEnabled = true,
  grants = [],
} = {}) {
  return {
    localFiles: {
      runtime: {
        localCodeExecutionEnabled: shellRuntimeEnabled,
        runCodeExecutionEnabled: runCodeRuntimeEnabled,
      },
      grants,
    },
    isToolEnabled: (id) => {
      if (id === 'bash_exec') return shellToolEnabled
      if (id === 'run_code') return runCodeToolEnabled
      return true
    },
  }
}

test('code execution status reports host shell and bounded run_code independently', async () => {
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
    const shellStatus = rootElement.querySelector('[data-testid="code-execution-shell-status"]')
    const runCodeStatus = rootElement.querySelector('[data-testid="code-execution-run-code-status"]')
    assert.ok(status)
    assert.ok(shellStatus)
    assert.ok(runCodeStatus)
    assert.match(shellStatus.textContent, /宿主命令已就绪，可在 1 个目录中运行/)
    assert.match(runCodeStatus.textContent, /受限 run_code 已就绪，不需要目录权限/)
    assert.match(status.textContent, /可执行读写目录1/)
    assert.match(status.textContent, /bash_exec 用户 Gate已启用/)
    assert.match(status.textContent, /run_code 用户 Gate已启用/)

    await act(async () => root.render(
      <CodeExecutionStatusSection controller={controller({ shellRuntimeEnabled: false })} t={t} />,
    ))
    assert.match(shellStatus.textContent, /当前部署已关闭宿主命令执行/)
    assert.match(runCodeStatus.textContent, /受限 run_code 已就绪，不需要目录权限/)

    await act(async () => root.render(
      <CodeExecutionStatusSection controller={controller({ shellToolEnabled: false })} t={t} />,
    ))
    assert.match(shellStatus.textContent, /bash_exec 已在权限中心关闭/)
    assert.match(runCodeStatus.textContent, /受限 run_code 已就绪，不需要目录权限/)

    await act(async () => root.render(
      <CodeExecutionStatusSection controller={controller()} t={t} />,
    ))
    assert.match(shellStatus.textContent, /请先给目标目录授予 read_write 权限/)
    assert.match(runCodeStatus.textContent, /受限 run_code 已就绪，不需要目录权限/)

    await act(async () => root.render(
      <CodeExecutionStatusSection
        controller={controller({
          runCodeRuntimeEnabled: false,
          grants: [{ resourceType: 'directory', accessMode: 'read_write', available: true }],
        })}
        t={t}
      />,
    ))
    assert.match(shellStatus.textContent, /宿主命令已就绪，可在 1 个目录中运行/)
    assert.match(runCodeStatus.textContent, /当前部署已关闭受限 run_code/)

    await act(async () => root.render(
      <CodeExecutionStatusSection
        controller={controller({
          runCodeToolEnabled: false,
          grants: [{ resourceType: 'directory', accessMode: 'read_write', available: true }],
        })}
        t={t}
      />,
    ))
    assert.match(shellStatus.textContent, /宿主命令已就绪，可在 1 个目录中运行/)
    assert.match(runCodeStatus.textContent, /run_code 已在权限中心关闭/)

    await act(async () => root.render(
      <CodeExecutionStatusSection
        controller={{ localFiles: { runtime: {}, grants: [] }, isToolEnabled: () => true }}
        t={t}
      />,
    ))
    assert.match(shellStatus.textContent, /后端未报告宿主命令状态，请重启服务/)
    assert.match(runCodeStatus.textContent, /后端未报告受限 run_code 状态，请重启服务/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

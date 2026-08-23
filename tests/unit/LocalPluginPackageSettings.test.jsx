import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { LocalPluginPackageManager } from '../../src/components/settings/LocalPluginPackageSettings.jsx'

const REVISION_A = `sha256-${'a'.repeat(64)}`
const REVISION_B = `sha256-${'b'.repeat(64)}`
const PACKAGE_DIGEST = `sha256-${'c'.repeat(64)}`
const SOURCE_DIRECTORY = 'D:\\plugins\\demo-transformer'

const labels = {
  'common.cancel': '取消',
  'settings.localPluginPackages': '本地插件包',
  'settings.localPluginPackagesDescription': '管理本地插件包',
  'settings.localPluginPackageInstall': '安装本地包',
  'settings.localPluginPackageRefresh': '刷新',
  'settings.localPluginPackageRecoveryRequired': '插件包需要本地恢复',
  'settings.localPluginPackageRecoveryHint': '解除第 {generation} 代屏障前重新核对状态',
  'settings.localPluginPackageRecoveryInterrupted': '检测到中断的插件包操作',
  'settings.localPluginPackageRecoveryInterruptedHint': '原进程在 {phase} 阶段退出，核对后解除第 {generation} 代屏障',
  'settings.localPluginPackageRecover': '安全核对并恢复',
  'settings.localPluginPackageLoadFailed': '加载失败',
  'settings.localPluginPackageNone': '尚未安装',
  'settings.localPluginPackageNoneHint': '选择插件包目录',
  'settings.localPluginPackageFiles': '{count} 个文件',
  'settings.localPluginPackageUpgrade': '升级',
  'settings.localPluginPackageUninstall': '卸载',
  'settings.localPluginPackageUninstallConfirmTitle': '确认卸载插件包',
  'settings.localPluginPackageUninstallConfirmHint': '卸载前检查所有引用',
  'settings.localPluginPackageUninstallConfirm': '确认卸载',
  'settings.localPluginPackageChooseUpgradeSource': '选择升级包目录',
  'settings.localPluginPackageChooseInstallSource': '选择插件包目录',
  'settings.localPluginPackageSourceHint': '选择包含 manifest 的目录',
  'settings.localPluginPackageSelectedSource': '已选择本机目录：',
  'settings.localPluginPackageConfirmInstallTitle': '确认安装此插件包',
  'settings.localPluginPackageConfirmUpgradeTitle': '确认升级此插件包',
  'settings.localPluginPackageConfirmInstall': '确认安装',
  'settings.localPluginPackageConfirmUpgrade': '确认升级',
  'settings.localPluginPackageWorking': '正在处理',
  'settings.localPluginPackageActionFailed': '本地插件包操作未完成',
  'settings.localPluginPackageActionFailedHint': '状态保持不变',
  'settings.localPluginPackageDependants': '依赖此插件',
  'settings.localPluginPackageSavedRestartRequired': '已安全保存，需重启后使用，请勿重复安装。',
  'settings.localPluginPackageInstalled': '已安装并刷新',
  'settings.localPluginPackageUpgraded': '已升级并刷新',
  'settings.localPluginPackageUnchanged': '无需更改',
  'settings.localPluginPackageUninstalled': '已卸载并刷新',
  'settings.localPluginPackageRecovered': '已核对并恢复',
  'settings.pluginLocalOwnerOnly': '仅本机所有者',
  'settings.pluginLoading': '加载中',
  'taskSteering.directoryBrowserPath': '目录路径',
  'taskSteering.directoryBrowserOpen': '打开',
  'taskSteering.directoryBrowserParent': '上一级',
  'taskSteering.directoryBrowserProject': '项目目录',
  'taskSteering.directoryBrowserDefault': '默认目录',
  'taskSteering.directoryBrowserEmpty': '没有子目录',
  'taskSteering.directoryBrowserLoading': '正在加载',
  'taskSteering.directoryBrowserLoadFailed': '目录加载失败',
  'taskSteering.directoryBrowserSelectCurrent': '选择当前目录',
}

const t = (key, values = {}) => String(labels[key] || key)
  .replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? `{${name}}`))

function packageEntry(overrides = {}) {
  return {
    schemaVersion: 1,
    pluginId: 'demo-transformer',
    pluginVersion: '2.0.0',
    packageDigest: PACKAGE_DIGEST,
    fileCount: 4,
    totalBytes: 1_024,
    installedAt: 1_777_777_777_000,
    publisherVerified: false,
    sourceKind: 'local-directory',
    ...overrides,
  }
}

function packageStore(revision = REVISION_A, packages = []) {
  return { schemaVersion: 1, revision, packages }
}

function listResponse(store) {
  return { schemaVersion: 1, store }
}

function mutationResponse(store, operation, overrides = {}) {
  return {
    schemaVersion: 1,
    store,
    result: { operation },
    refreshPending: false,
    restartRequired: false,
    ...overrides,
  }
}

function directoryResponse() {
  return {
    ok: true,
    directory: {
      currentPath: SOURCE_DIRECTORY,
      parentPath: 'D:\\plugins',
      projectDirectory: SOURCE_DIRECTORY,
      defaultOutputDirectory: SOURCE_DIRECTORY,
      entries: [],
    },
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/settings',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function click(dom, element) {
  assert.ok(element, 'expected clickable element')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await settle()
  })
}

function findButton(container, text) {
  const found = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent.trim() === text)
  assert.ok(found, `missing button: ${text}`)
  return found
}

async function selectCurrentDirectory(dom, rootElement, actionLabel) {
  await click(dom, findButton(rootElement, actionLabel))
  const browser = rootElement.querySelector('[data-testid="inline-directory-browser"]')
  assert.ok(browser)
  await click(dom, findButton(browser, '选择当前目录'))
  assert.equal(rootElement.querySelector('[data-testid="inline-directory-browser"]'), null)
  const confirmation = rootElement.querySelector('[data-testid="local-plugin-package-source-confirm"]')
  assert.ok(confirmation)
  assert.match(confirmation.textContent, /D:\\plugins\\demo-transformer/)
  return confirmation
}

async function renderManager({ fetchImpl, onPackagesChanged } = {}) {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  await act(async () => {
    root.render(<LocalPluginPackageManager t={t} onPackagesChanged={onPackagesChanged} />)
    await settle()
  })
  return {
    dom,
    root,
    rootElement,
    async cleanup() {
      await act(async () => root.unmount())
      dom.window.close()
      globalThis.fetch = originalFetch
    },
  }
}

test('selecting an install directory does not submit until explicit confirmation', async () => {
  const calls = []
  const installedStore = packageStore(REVISION_B, [packageEntry()])
  const harness = await renderManager({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (url === '/api/plugins/packages') return response(listResponse(packageStore()))
      if (url === '/api/local-files/browse-directories') return response(directoryResponse())
      if (url === '/api/plugins/packages/actions/import') {
        return response(mutationResponse(installedStore, 'installed'))
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })

  try {
    const confirmation = await selectCurrentDirectory(
      harness.dom,
      harness.rootElement,
      '安装本地包',
    )
    assert.equal(calls.filter((call) => call.url.endsWith('/actions/import')).length, 0)

    await click(harness.dom, findButton(confirmation, '确认安装'))
    const imports = calls.filter((call) => call.url.endsWith('/actions/import'))
    assert.equal(imports.length, 1)
    assert.deepEqual(JSON.parse(imports[0].init.body), {
      sourceDirectory: SOURCE_DIRECTORY,
      expectedRevision: REVISION_A,
      replace: false,
    })
  } finally {
    await harness.cleanup()
  }
})

test('upgrade uses replacement identity and a CAS conflict never retries or clears the selection', async () => {
  const calls = []
  let listReads = 0
  const harness = await renderManager({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (url === '/api/plugins/packages') {
        listReads += 1
        return response(listResponse(packageStore(
          listReads === 1 ? REVISION_A : REVISION_B,
          [packageEntry()],
        )))
      }
      if (url === '/api/local-files/browse-directories') return response(directoryResponse())
      if (url === '/api/plugins/packages/actions/import') {
        return response({
          ok: false,
          error: {
            code: 'PLUGIN_PACKAGE_REVISION_CONFLICT',
            message: 'package store revision changed',
          },
        }, 409)
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })

  try {
    const confirmation = await selectCurrentDirectory(harness.dom, harness.rootElement, '升级')
    assert.equal(calls.filter((call) => call.url.endsWith('/actions/import')).length, 0)
    await click(harness.dom, findButton(confirmation, '确认升级'))

    const imports = calls.filter((call) => call.url.endsWith('/actions/import'))
    assert.equal(imports.length, 1)
    assert.deepEqual(JSON.parse(imports[0].init.body), {
      sourceDirectory: SOURCE_DIRECTORY,
      expectedRevision: REVISION_A,
      replace: true,
      expectedPluginId: 'demo-transformer',
    })
    assert.equal(listReads, 2)
    const retained = harness.rootElement.querySelector('[data-testid="local-plugin-package-source-confirm"]')
    assert.ok(retained)
    assert.match(retained.textContent, /D:\\plugins\\demo-transformer/)
    assert.match(
      harness.rootElement.querySelector('[data-testid="local-plugin-package-error"]').textContent,
      /package store revision changed/,
    )
    await act(async () => settle())
    assert.equal(calls.filter((call) => call.url.endsWith('/actions/import')).length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('uninstall is confirmed inline without window.confirm and exposes safe blocker details', async () => {
  const calls = []
  let confirmCalls = 0
  const harness = await renderManager({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (url === '/api/plugins/packages') {
        return response(listResponse(packageStore(REVISION_A, [packageEntry()])))
      }
      if (url === '/api/plugins/packages/demo-transformer') {
        return response({
          ok: false,
          error: {
            code: 'PLUGIN_PACKAGE_UNINSTALL_BLOCKED',
            message: 'plugin package is still referenced',
            details: {
              dependantPluginIds: ['dependent-plugin'],
              blockingReasons: ['release_exists', 'checkpoint_exists'],
            },
          },
        }, 409)
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })
  harness.dom.window.confirm = () => {
    confirmCalls += 1
    throw new Error('window.confirm must not be used')
  }

  try {
    await click(harness.dom, findButton(harness.rootElement, '卸载'))
    const inline = harness.rootElement.querySelector(
      '[data-testid="local-plugin-package-uninstall-confirm-demo-transformer"]',
    )
    assert.ok(inline)
    assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 0)

    await click(harness.dom, findButton(inline, '确认卸载'))
    assert.equal(confirmCalls, 0)
    assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 1)
    const error = harness.rootElement.querySelector('[data-testid="local-plugin-package-error"]')
    assert.ok(error)
    assert.match(error.textContent, /dependent-plugin/)
    assert.match(error.textContent, /release_exists/)
    assert.match(error.textContent, /checkpoint_exists/)
  } finally {
    await harness.cleanup()
  }
})

test('refreshPending reports restart without replaying the successful mutation', async () => {
  const calls = []
  let callbackCalls = 0
  let currentStore = packageStore()
  const harness = await renderManager({
    onPackagesChanged: async () => {
      callbackCalls += 1
      throw new Error('runtime inventory refresh failed')
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (url === '/api/plugins/packages') return response(listResponse(currentStore))
      if (url === '/api/local-files/browse-directories') return response(directoryResponse())
      if (url === '/api/plugins/packages/actions/import') {
        currentStore = packageStore(REVISION_B, [packageEntry()])
        return response(mutationResponse(currentStore, 'installed', { refreshPending: true }))
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })

  try {
    const confirmation = await selectCurrentDirectory(
      harness.dom,
      harness.rootElement,
      '安装本地包',
    )
    await click(harness.dom, findButton(confirmation, '确认安装'))
    assert.equal(callbackCalls, 1)
    assert.equal(calls.filter((call) => call.url.endsWith('/actions/import')).length, 1)
    assert.equal(harness.rootElement.querySelector('[data-testid="local-plugin-package-source-confirm"]'), null)
    const notice = harness.rootElement.querySelector('[data-testid="local-plugin-package-notice"]')
    assert.ok(notice)
    assert.match(notice.textContent, /需重启/)
    assert.match(notice.textContent, /请勿重复安装/)

    await click(harness.dom, findButton(harness.rootElement, '刷新'))
    assert.equal(calls.filter((call) => call.url.endsWith('/actions/import')).length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('an orphaned package barrier is explained and recovered with exact CAS fields', async () => {
  const calls = []
  const recovery = {
    pluginId: 'demo-transformer',
    generation: 7,
    operation: 'uninstall',
    phase: 'mutating',
    ownerPid: 999999,
    recoveryRequired: false,
    createdAt: 100,
    heartbeatAt: 150,
  }
  const harness = await renderManager({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (url === '/api/plugins/packages') {
        return response({
          ...listResponse(packageStore()),
          recoveries: [recovery],
        })
      }
      if (url === '/api/plugins/packages/demo-transformer/actions/recover') {
        return response({
          schemaVersion: 1,
          recovered: true,
          outcome: 'uninstalled',
          store: packageStore(REVISION_B),
          receipt: { pluginId: 'demo-transformer', generation: 7 },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    },
  })

  try {
    assert.match(harness.rootElement.textContent, /检测到中断的插件包操作/)
    assert.match(harness.rootElement.textContent, /mutating/)
    await click(harness.dom, findButton(harness.rootElement, '安全核对并恢复'))
    const recoverCalls = calls.filter((call) => call.url.endsWith('/actions/recover'))
    assert.equal(recoverCalls.length, 1)
    assert.deepEqual(JSON.parse(recoverCalls[0].init.body), {
      expectedRevision: REVISION_A,
      expectedGeneration: 7,
    })
    assert.equal(harness.rootElement.textContent.includes('检测到中断的插件包操作'), false)
    assert.match(harness.rootElement.textContent, /已核对并恢复/)
  } finally {
    await harness.cleanup()
  }
})

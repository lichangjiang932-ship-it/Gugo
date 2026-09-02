import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

import WorkspaceProjectPicker from '../../src/pages/ChatSplit/chatMessages/WorkspaceProjectPicker.jsx'
import { CHAT_PROJECTS_STORAGE_KEY } from '../../src/lib/chatWorkspaceSelection.js'

const copy = {
  'chatMessages.workspaceSelectProject': '选择项目',
  'chatMessages.workspaceDefaultHint': '未选择项目时使用默认文件夹',
  'chatMessages.workspaceSearchProjects': '搜索项目',
  'chatMessages.workspaceProjects': '项目',
  'chatMessages.workspaceRecent': '最近',
  'chatMessages.workspaceRecentEmpty': '暂无最近项目',
  'chatMessages.workspaceNoMatchingProjects': '没有匹配的项目',
  'chatMessages.workspaceUseDefault': '使用默认文件夹',
  'chatMessages.workspaceNewProject': '新建项目',
  'chatMessages.workspaceCreateTitle': '新建项目',
  'chatMessages.workspaceCreateHint': '名称可选，留空时使用文件夹名称',
  'chatMessages.workspaceProjectName': '项目名称（可选）',
  'chatMessages.workspaceProjectNamePlaceholder': '留空则使用文件夹名称',
  'chatMessages.workspaceSourceFolder': '源文件夹',
  'chatMessages.workspaceSourceFolderEmpty': '尚未选择文件夹',
  'chatMessages.workspaceChooseSource': '选择文件夹',
  'chatMessages.workspaceCreate': '创建项目',
  'chatMessages.workspaceCreating': '正在创建',
  'chatMessages.workspaceServiceRestartRequired': '请重启 Gugo 本地服务',
  'chatMessages.workspaceSelectionFailed': '无法使用所选项目',
  'common.cancel': '取消',
  'common.close': '关闭',
}

const t = (key) => copy[key] || key

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="outside"></div><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.localStorage = dom.window.localStorage
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.InputEvent = dom.window.InputEvent
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function setInputValue(dom, input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.window.InputEvent('input', {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: 'insertText',
  }))
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

function StubDirectoryBrowser({ onSelect }) {
  return (
    <button type="button" onClick={() => onSelect('D:\\Work\\source-project')} data-testid="stub-directory">
      Use source folder
    </button>
  )
}

test('project picker searches, closes accessibly, and creates a real selected project', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const activations = []

  function Harness() {
    const [selectedPath, setSelectedPath] = useState('')
    return (
      <WorkspaceProjectPicker
        DirectoryBrowser={StubDirectoryBrowser}
        pickSourceDirectory={async () => ({ supported: false, canceled: false, path: '' })}
        onClearWorkspace={() => setSelectedPath('')}
        onSelectWorkspace={async (path) => {
          activations.push(path)
          const canonicalPath = path === 'D:\\Work\\source-project'
            ? 'D:\\Work\\Source Project Canonical'
            : path
          setSelectedPath(canonicalPath)
          return { path: canonicalPath }
        }}
        recentWorkspaces={[
          { path: 'D:\\Work\\alpha', name: 'Alpha', usedAt: 20 },
          { path: 'D:\\Work\\beta', name: 'Beta', usedAt: 10 },
        ]}
        selectedWorkspacePath={selectedPath}
        t={t}
      />
    )
  }

  try {
    localStorage.setItem(CHAT_PROJECTS_STORAGE_KEY, JSON.stringify([
      { path: 'D:\\Work\\alpha', name: 'Browser-only alias', usedAt: 99 },
      { path: 'D:\\Old\\stale', name: 'Stale project', usedAt: 100 },
    ]))
    await act(async () => root.render(<Harness />))
    const trigger = rootElement.querySelector('[data-testid="workspace-project-trigger"]')
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')

    await act(async () => trigger.click())
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 1)))
    let popover = rootElement.querySelector('[data-testid="workspace-project-popover"]')
    const search = popover.querySelector('input')
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, search)
    assert.equal(popover.querySelector('[data-testid="workspace-projects-group"]'), null)
    assert.equal(popover.querySelector('[data-testid="workspace-recent-group"]').getAttribute('aria-label'), '最近')
    assert.equal(popover.querySelectorAll('[data-testid="workspace-recent-group"] [role="option"]').length, 2)
    assert.deepEqual(
      [...popover.querySelectorAll('[data-testid="workspace-recent-group"] [role="option"]')]
        .map((option) => option.textContent.trim()),
      ['alpha', 'beta'],
    )
    assert.doesNotMatch(popover.textContent, /Browser-only alias|Stale project/)
    await act(async () => setInputValue(dom, search, 'beta'))
    assert.deepEqual(
      [...popover.querySelectorAll('[data-testid="workspace-project-option"]')].map((option) => option.textContent.trim()),
      ['beta'],
    )
    assert.equal(popover.querySelector('[data-testid="workspace-project-option"]').title, 'D:\\Work\\beta')

    await act(async () => search.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })))
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 1)))
    assert.equal(rootElement.querySelector('[data-testid="workspace-project-popover"]'), null)
    assert.equal(document.activeElement, trigger)

    await act(async () => trigger.click())
    await act(async () => document.getElementById('outside').dispatchEvent(new dom.window.MouseEvent('mousedown', {
      bubbles: true,
    })))
    assert.equal(rootElement.querySelector('[data-testid="workspace-project-popover"]'), null)

    await act(async () => trigger.click())
    popover = rootElement.querySelector('[data-testid="workspace-project-popover"]')
    await act(async () => popover.querySelector('[data-testid="workspace-new-project"]').click())
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog)
    const nameInput = dialog.querySelector('[data-testid="workspace-project-name"]')
    const createButton = dialog.querySelector('[data-testid="workspace-create-project"]')
    assert.equal(document.activeElement, dialog.querySelector('[data-testid="workspace-choose-source"]'))
    assert.equal(createButton.disabled, true)

    await act(async () => setInputValue(dom, nameInput, '官网改版'))
    await act(async () => dialog.querySelector('[data-testid="workspace-choose-source"]').click())
    await act(async () => dialog.querySelector('[data-testid="stub-directory"]').click())
    assert.equal(dialog.querySelector('[data-testid="workspace-source-path"]').textContent, 'D:\\Work\\source-project')
    assert.equal(createButton.disabled, false)

    await act(async () => {
      createButton.click()
      await Promise.resolve()
    })
    assert.deepEqual(activations, ['D:\\Work\\source-project'])
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(trigger.textContent, /Source Project Canonical/)
    assert.match(trigger.title, /Source Project Canonical/)
    const stored = JSON.parse(localStorage.getItem(CHAT_PROJECTS_STORAGE_KEY))
    assert.equal(stored[0].name, '官网改版')
    assert.equal(stored[0].path, 'D:\\Work\\Source Project Canonical')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.localStorage
  }
})

test('native source folder selection keeps the current path when the user cancels', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let calls = 0

  function UnexpectedFallback() {
    return <div data-testid="unexpected-fallback" />
  }

  try {
    await act(async () => root.render(
      <WorkspaceProjectPicker
        DirectoryBrowser={UnexpectedFallback}
        pickSourceDirectory={async () => {
          calls += 1
          return calls === 1
            ? { supported: true, canceled: false, path: 'D:\\Native\\project' }
            : { supported: true, canceled: true, path: '' }
        }}
        t={t}
      />,
    ))
    await act(async () => rootElement.querySelector('[data-testid="workspace-project-trigger"]').click())
    await act(async () => rootElement.querySelector('[data-testid="workspace-new-project"]').click())
    const dialog = document.querySelector('[role="dialog"]')
    const chooseButton = dialog.querySelector('[data-testid="workspace-choose-source"]')

    await act(async () => {
      chooseButton.click()
      await Promise.resolve()
    })
    assert.equal(dialog.querySelector('[data-testid="workspace-source-path"]').textContent, 'D:\\Native\\project')

    await act(async () => {
      chooseButton.click()
      await Promise.resolve()
    })
    assert.equal(dialog.querySelector('[data-testid="workspace-source-path"]').textContent, 'D:\\Native\\project')
    assert.equal(dialog.querySelector('[data-testid="unexpected-fallback"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.localStorage
  }
})

test('a selected folder name becomes the project name when the optional name is blank', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const activations = []
  let managedCreations = 0

  try {
    await act(async () => root.render(
      <WorkspaceProjectPicker
        createManagedProject={async () => {
          managedCreations += 1
          return { path: 'D:\\unexpected' }
        }}
        onSelectWorkspace={async (path) => {
          activations.push(path)
          return { path }
        }}
        pickSourceDirectory={async () => ({
          supported: true,
          canceled: false,
          path: 'D:\\Work\\source-project',
        })}
        t={t}
      />,
    ))
    await act(async () => rootElement.querySelector('[data-testid="workspace-project-trigger"]').click())
    await act(async () => rootElement.querySelector('[data-testid="workspace-new-project"]').click())
    const dialog = document.querySelector('[role="dialog"]')

    assert.match(
      dialog.querySelector('[data-testid="workspace-project-name"]').placeholder,
      /文件夹名称/,
    )
    await act(async () => {
      dialog.querySelector('[data-testid="workspace-choose-source"]').click()
      await Promise.resolve()
    })
    await act(async () => {
      dialog.querySelector('[data-testid="workspace-create-project"]').click()
      await Promise.resolve()
    })

    assert.equal(managedCreations, 0)
    assert.deepEqual(activations, ['D:\\Work\\source-project'])
    const stored = JSON.parse(localStorage.getItem(CHAT_PROJECTS_STORAGE_KEY))
    assert.equal(stored[0].name, 'source-project')
    assert.equal(stored[0].path, 'D:\\Work\\source-project')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.localStorage
  }
})

test('source folder selection shows native picker failures without opening the inline browser', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  function UnexpectedFallback() {
    return <div data-testid="unexpected-fallback" />
  }

  try {
    await act(async () => root.render(
      <WorkspaceProjectPicker
        DirectoryBrowser={UnexpectedFallback}
        pickSourceDirectory={async () => { throw new Error('系统文件夹选择器暂时不可用') }}
        t={t}
      />,
    ))
    await act(async () => rootElement.querySelector('[data-testid="workspace-project-trigger"]').click())
    await act(async () => rootElement.querySelector('[data-testid="workspace-new-project"]').click())
    const dialog = document.querySelector('[role="dialog"]')

    await act(async () => {
      dialog.querySelector('[data-testid="workspace-choose-source"]').click()
      await Promise.resolve()
    })

    assert.equal(dialog.querySelector('[data-testid="unexpected-fallback"]'), null)
    assert.equal(dialog.querySelector('[role="alert"]').textContent, '系统文件夹选择器暂时不可用')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.localStorage
  }
})

test('project creation uses a managed default folder when no source folder is selected', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const managedCreations = []
  const activations = []

  function Harness() {
    const [selectedPath, setSelectedPath] = useState('')
    return (
      <WorkspaceProjectPicker
        createManagedProject={async (name) => {
          managedCreations.push(name)
          return { path: 'D:\\Gugo Projects\\managed-project-a1b2c3d4' }
        }}
        onClearWorkspace={() => setSelectedPath('')}
        onSelectWorkspace={async (workspacePath) => {
          activations.push(workspacePath)
          setSelectedPath(workspacePath)
          return { path: workspacePath }
        }}
        selectedWorkspacePath={selectedPath}
        t={t}
      />
    )
  }

  try {
    await act(async () => root.render(<Harness />))
    const trigger = rootElement.querySelector('[data-testid="workspace-project-trigger"]')
    await act(async () => trigger.click())
    await act(async () => rootElement.querySelector('[data-testid="workspace-new-project"]').click())
    const dialog = document.querySelector('[role="dialog"]')
    const nameInput = dialog.querySelector('[data-testid="workspace-project-name"]')
    const createButton = dialog.querySelector('[data-testid="workspace-create-project"]')

    assert.equal(createButton.disabled, true)
    await act(async () => setInputValue(dom, nameInput, '默认目录项目'))
    assert.equal(createButton.disabled, false)
    assert.match(dialog.querySelector('[data-testid="workspace-source-path"]').textContent, /尚未选择文件夹/)

    await act(async () => {
      createButton.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    assert.deepEqual(managedCreations, ['默认目录项目'])
    assert.deepEqual(activations, ['D:\\Gugo Projects\\managed-project-a1b2c3d4'])
    assert.equal(document.querySelector('[role="dialog"]'), null)
    const stored = JSON.parse(localStorage.getItem(CHAT_PROJECTS_STORAGE_KEY))
    assert.equal(stored[0].name, '默认目录项目')
    assert.equal(stored[0].path, 'D:\\Gugo Projects\\managed-project-a1b2c3d4')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.localStorage
  }
})

test('managed project creation failures stay visible in the new-project dialog', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let selectionCalls = 0

  try {
    await act(async () => root.render(
      <WorkspaceProjectPicker
        createManagedProject={async () => {
          throw new Error('无法创建默认项目目录')
        }}
        onSelectWorkspace={async () => {
          selectionCalls += 1
          return { path: 'D:\\unexpected' }
        }}
        t={t}
      />,
    ))
    await act(async () => rootElement.querySelector('[data-testid="workspace-project-trigger"]').click())
    await act(async () => rootElement.querySelector('[data-testid="workspace-new-project"]').click())
    const dialog = document.querySelector('[role="dialog"]')
    await act(async () => setInputValue(
      dom,
      dialog.querySelector('[data-testid="workspace-project-name"]'),
      '失败项目',
    ))

    await act(async () => {
      dialog.querySelector('[data-testid="workspace-create-project"]').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    assert.equal(selectionCalls, 0)
    assert.ok(document.querySelector('[role="dialog"]'))
    assert.equal(dialog.querySelector('[role="alert"]').textContent, '无法创建默认项目目录')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.localStorage
  }
})

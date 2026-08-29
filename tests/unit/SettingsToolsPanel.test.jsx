import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsToolsPanel from '../../src/components/settings/SettingsToolsPanel.jsx'
import { translateKey } from '../../src/i18n/translations.js'

const EXPECTED_TOOL_IDS = [
  'fetch_url',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_pdf',
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_code',
  'run_command',
  'run_test',
  'docker_exec',
  'file_download',
  'git_status',
  'git_diff',
  'git_commit',
  'git_push',
  'git_rollback',
  'git_write',
  'run_project_check',
  'image_info',
  'image_transform',
  'media_probe',
  'media_transform',
  'pdf_info',
  'pdf_text',
  'pdf_transform',
  'archive_list',
  'archive_create',
  'archive_extract',
  'batch_rename',
  'file_hash_manifest',
]

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/settings/tools',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('code execution settings describe the local runtime honestly and keep the toggle wired', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const actions = []

  try {
    await act(async () => root.render(
      <SettingsToolsPanel
        state={{ toolsConfig: { bash_exec: true, run_code: true, archive_create: false } }}
        dispatch={(action) => actions.push(action)}
        t={(key) => translateKey(key, 'zh')}
      />,
    ))

    assert.match(rootElement.textContent, /执行代码与命令/)
    assert.match(rootElement.textContent, /Python、Node、PowerShell/)
    assert.match(rootElement.textContent, /已授权的读写目录/)
    assert.match(rootElement.textContent, /受限代码计算/)
    assert.doesNotMatch(rootElement.textContent, /服务端还需显式启用/)
    assert.equal(rootElement.querySelectorAll('button[data-tool-id]').length, EXPECTED_TOOL_IDS.length)
    for (const id of EXPECTED_TOOL_IDS) {
      assert.ok(rootElement.querySelector(`button[data-tool-id="${id}"]`), `${id} toggle is missing`)
      assert.match(rootElement.textContent, new RegExp(id))
    }

    const toggle = rootElement.querySelector('button[aria-label="执行代码与命令: 开启"]')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
    await act(async () => toggle.click())

    const archiveToggle = rootElement.querySelector('button[aria-label="创建 ZIP 压缩包: 关闭"]')
    assert.ok(archiveToggle)
    assert.equal(archiveToggle.getAttribute('aria-pressed'), 'false')
    await act(async () => archiveToggle.click())
    assert.deepEqual(actions, [
      { type: 'SET_TOOLS_CONFIG', payload: { bash_exec: false } },
      { type: 'SET_TOOLS_CONFIG', payload: { archive_create: true } },
    ])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('PDF generator settings labels exist in every supported language', () => {
  for (const language of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    assert.notEqual(translateKey('settingsTools.tools.create_pdf.name', language), 'settingsTools.tools.create_pdf.name')
    assert.notEqual(translateKey('settingsTools.tools.run_code.name', language), 'settingsTools.tools.run_code.name')
    assert.notEqual(translateKey('chatMessages.toolCreatePdf', language), 'chatMessages.toolCreatePdf')
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('tool readiness is visible without a tool card and yields to the single durable tool call', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const baseMessage = {
    id: 'assistant-code-execution',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
  }
  const t = (key, values = {}) => key === 'chatMessages.toolCallReady'
    ? `正在准备运行 ${values.name}…`
    : key

  const renderMessage = async (meta) => {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={{ ...baseMessage, meta }}
          rowKey={baseMessage.id}
          generatingMessageId={baseMessage.id}
          lang="zh"
          t={t}
        />
      </I18nProvider>,
    ))
  }

  try {
    await renderMessage({
      streaming: true,
      modelActivity: { kind: 'tool_call_ready', toolName: 'bash_exec' },
      toolCalls: [],
    })

    const readiness = rootElement.querySelector('[data-testid="model-activity"]')
    assert.ok(readiness)
    assert.match(readiness.textContent, /正在准备运行 bash_exec/)
    assert.equal(rootElement.querySelectorAll('.chat-run-timeline').length, 0)
    assert.equal(rootElement.querySelector('.animate-pulse'), null)

    await renderMessage({
      streaming: true,
      modelActivity: null,
      toolCalls: [{
        id: 'call-bash-exec-1',
        name: 'bash_exec',
        arguments: JSON.stringify({ command: 'python verify.py' }),
        status: 'running',
        textOffset: 0,
      }],
    })

    assert.equal(rootElement.querySelector('[data-testid="model-activity"]'), null)
    assert.equal(rootElement.querySelectorAll('.chat-run-timeline').length, 1)
    assert.equal(rootElement.querySelectorAll('.chat-tool-list > *').length, 1)
    assert.equal(rootElement.querySelector('.animate-pulse'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a persisted file owned by a tool call opens from the execution step summary', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'assistant-file-step',
    role: 'assistant',
    content: 'Created the script.',
    timestamp: Date.now(),
    meta: {
      toolCalls: [{
        id: 'write-script-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'D:\\work\\inspect_pdf.py' }),
        result: JSON.stringify({ ok: true, artifactId: 'script-artifact-1' }),
        status: 'success',
        textOffset: 0,
      }],
      serverArtifacts: [{
        id: 'script-artifact-1',
        toolCallId: 'write-script-1',
        filename: 'inspect_pdf.py',
        type: 'text',
        mimeType: 'text/x-python',
        url: '/api/artifacts/script-artifact-1',
      }],
    },
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={msg}
          rowKey={msg.id}
          generatingMessageId=""
          lang="en"
          onOpenArtifact={(artifact) => opened.push(artifact)}
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    const fileButton = rootElement.querySelector('[data-testid="tool-summary-open"]')
    assert.ok(fileButton)
    assert.match(fileButton.textContent, /inspect_pdf\.py/)
    await act(async () => fileButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))

    assert.equal(opened.length, 1)
    assert.deepEqual(opened[0].directFile, {
      id: 'script-artifact-1',
      filename: 'inspect_pdf.py',
      title: undefined,
      type: 'text',
      mimeType: 'text/x-python',
      url: '/api/artifacts/script-artifact-1',
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('intermediate files stay available in execution steps while only final deliverables appear below', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const calls = [
    ['draft', 'draft.py'],
    ['preview', 'preview.png'],
    ['final', 'report.pdf'],
  ].map(([id, filename]) => ({
    id: `write-${id}`,
    name: 'write_file',
    arguments: JSON.stringify({ path: `D:\\work\\${filename}` }),
    result: JSON.stringify({ ok: true, artifactId: id }),
    status: 'success',
    textOffset: 0,
  }))
  const serverArtifacts = calls.map((call, index) => ({
    id: ['draft', 'preview', 'final'][index],
    toolCallId: call.id,
    filename: ['draft.py', 'preview.png', 'report.pdf'][index],
    type: 'file',
    url: `/api/artifacts/${['draft', 'preview', 'final'][index]}`,
  }))
  const baseMessage = {
    id: 'assistant-delivery-filter',
    role: 'assistant',
    content: 'Task completed.',
    timestamp: Date.now(),
    meta: {
      toolCalls: calls,
      serverArtifacts,
      serverDeliveryArtifactIds: ['final'],
    },
  }

  const renderMessage = async (msg) => act(async () => root.render(
    <I18nProvider>
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="en"
        onOpenArtifact={(artifact) => opened.push(artifact)}
        t={(key) => key}
      />
    </I18nProvider>,
  ))

  try {
    await renderMessage(baseMessage)
    const stepFiles = [...rootElement.querySelectorAll('[data-testid="tool-summary-open"]')]
    assert.deepEqual(
      stepFiles.map((button) => button.textContent.trim().split(/[\\/]/).pop()),
      ['draft.py', 'preview.png', 'report.pdf'],
    )
    const deliveries = [...rootElement.querySelectorAll('[data-testid="artifact-open-card"]')]
    assert.equal(deliveries.length, 1)
    assert.match(deliveries[0].textContent, /report\.pdf/)
    assert.doesNotMatch(deliveries[0].textContent, /draft\.py|preview\.png/)

    await act(async () => stepFiles[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(opened[0].directFile.filename, 'draft.py')

    await renderMessage({
      ...baseMessage,
      meta: { ...baseMessage.meta, serverDeliveryArtifactIds: [] },
    })
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-summary-open"]').length, 3)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

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
    assert.match(readiness.textContent, /Preparing bash_exec/)
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

test('completed assistant turn renders its persisted total elapsed time', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-with-total-duration',
    role: 'assistant',
    content: 'The task is complete.',
    timestamp: 100_000,
    meta: {
      serverTurnId: 'turn-with-total-duration',
      turnStartedAt: 100_000,
      turnCompletedAt: 165_000,
    },
  }
  const t = (key, values = {}) => {
    if (key === 'chatMessages.elapsed') return `Elapsed ${values.value}`
    if (key === 'chatMessages.durationMinutesSeconds') return `${values.minutes}m ${values.seconds}s`
    if (key === 'chatMessages.durationSeconds') return `${values.seconds}s`
    return key
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={msg}
          rowKey={msg.id}
          generatingMessageId=""
          lang="en"
          t={t}
        />
      </I18nProvider>,
    ))

    const durationHeader = rootElement.querySelector('[data-testid="task-duration-header"]')
    assert.ok(durationHeader)
    assert.equal(durationHeader.textContent, 'Elapsed 1m 5s')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('assistant keeps narration and tools in true DOM order with the current command expanded last', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const beforeTool = 'Checked the project files.\n\n'
  const afterTool = 'Generated the page and started verification.'
  const content = `${beforeTool}${afterTool}`
  const msg = {
    id: 'assistant-ordered-timeline',
    role: 'assistant',
    content,
    timestamp: Date.now(),
    meta: {
      streaming: true,
      toolCalls: [{
        id: 'read-project',
        name: 'list_directory',
        arguments: JSON.stringify({ path: 'D:\\work' }),
        result: JSON.stringify({ ok: true }),
        status: 'success',
        textOffset: beforeTool.length,
      }, {
        id: 'verify-page',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'npm test' }),
        status: 'running',
        liveOutput: 'starting verification\n3 tests passed',
        textOffset: content.length,
      }],
    },
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={msg}
          rowKey={msg.id}
          generatingMessageId={msg.id}
          lang="en"
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    const quotable = rootElement.querySelector('[data-quotable="true"]')
    assert.ok(quotable)
    const executionToggle = quotable.querySelector('[data-testid="execution-toggle"]')
    assert.equal(executionToggle?.getAttribute('aria-expanded'), 'true')
    const executionContent = quotable.querySelector('[data-testid="execution-content"]')
    assert.ok(executionContent)
    const orderedChildren = [...executionContent.children].slice(0, 4)
    assert.deepEqual(
      orderedChildren.map((element) => element.classList.contains('chat-markdown') ? 'text' : 'tools'),
      ['text', 'tools', 'text', 'tools'],
    )
    assert.match(orderedChildren[0].textContent, /Checked the project files/)
    assert.match(orderedChildren[2].textContent, /Generated the page and started verification/)

    const timelines = [...executionContent.querySelectorAll(':scope > .chat-run-timeline')]
    assert.equal(timelines.length, 2)
    assert.equal(timelines[0].querySelector('.chat-tool-step-marker')?.textContent, '1')
    assert.equal(timelines[1].querySelector('.chat-tool-step-marker')?.textContent, '2')
    assert.match(timelines[1].querySelector('[data-testid="tool-detail-arguments"]')?.textContent || '', /npm test/)
    assert.match(timelines[1].querySelector('[data-testid="tool-live-output"]')?.textContent || '', /3 tests passed/)

    const runningToggle = timelines[1].querySelector('[data-testid="tool-step-toggle"]')
    assert.equal(runningToggle?.getAttribute('aria-expanded'), 'true')
    await act(async () => runningToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(timelines[1].querySelector('[data-testid="tool-step-details"]'), null)
    assert.equal(runningToggle.getAttribute('aria-expanded'), 'false')
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
      serverDeliveryArtifactIds: ['script-artifact-1'],
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
    const executionToggle = rootElement.querySelector('[data-testid="execution-toggle"]')
    assert.equal(executionToggle?.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-testid="execution-content"]'), null)
    await act(async () => executionToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const expandedFileButton = rootElement.querySelector('[data-testid="tool-summary-open"]')
    assert.equal(fileButton, null)
    assert.ok(expandedFileButton)
    assert.match(expandedFileButton.textContent, /inspect_pdf\.py/)
    await act(async () => expandedFileButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))

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

test('only final deliverables are clickable in execution steps and appear below', async () => {
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
    const executionToggle = rootElement.querySelector('[data-testid="execution-toggle"]')
    assert.equal(executionToggle?.getAttribute('aria-expanded'), 'false')
    await act(async () => executionToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    const stepSummaries = [...rootElement.querySelectorAll('.chat-tool-summary')]
    assert.deepEqual(
      stepSummaries.map((summary) => summary.textContent.trim().split(/[\\/]/).pop()),
      ['draft.py', 'preview.png', 'report.pdf'],
    )
    const stepFiles = [...rootElement.querySelectorAll('[data-testid="tool-summary-open"]')]
    assert.equal(stepFiles.length, 1)
    assert.equal(stepFiles[0].textContent.trim().split(/[\\/]/).pop(), 'report.pdf')
    const deliveries = [...rootElement.querySelectorAll('[data-testid="artifact-open-card"]')]
    assert.equal(deliveries.length, 1)
    assert.match(deliveries[0].textContent, /report\.pdf/)
    assert.doesNotMatch(deliveries[0].textContent, /draft\.py|preview\.png/)

    await act(async () => stepFiles[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(opened[0].directFile.filename, 'report.pdf')

    await renderMessage({
      ...baseMessage,
      meta: { ...baseMessage.meta, serverDeliveryArtifactIds: [] },
    })
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-summary-open"]').length, 0)
    assert.equal(rootElement.querySelectorAll('.chat-tool-summary').length, 3)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an interrupted resumable turn hides retained output until the turn completes', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-interrupted-delivery',
    role: 'assistant',
    content: 'Recovery is pending.',
    timestamp: Date.now(),
    meta: {
      streaming: true,
      interrupted: true,
      serverTurnId: 'turn-interrupted-delivery',
      verifiedLocalFiles: [{
        id: 'verified-report',
        path: 'D:\\work\\verified-report.pdf',
        filename: 'verified-report.pdf',
      }],
    },
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={msg}
          rowKey={msg.id}
          generatingMessageId={msg.id}
          lang="en"
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    assert.equal(rootElement.querySelector('[data-testid="execution-toggle"]')?.getAttribute('aria-expanded'), 'true')
    assert.equal(rootElement.querySelector('[data-testid="artifact-open-card"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a failed turn never exposes retained artifacts as deliverables', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-partial-delivery',
    role: 'assistant',
    content: 'The page was created before a later step failed.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      serverArtifacts: [{
        id: 'delivered-html',
        filename: 'gallery.html',
        type: 'html',
        url: '/api/artifacts/delivered-html',
      }],
      serverDeliveryArtifactIds: ['delivered-html'],
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
          t={(key) => key === 'chatMessages.replyIncomplete'
            ? 'Unverified files were not delivered'
            : key}
        />
      </I18nProvider>,
    ))

    const completionState = rootElement.querySelector('[data-testid="reply-completion-state"]')
    assert.equal(completionState?.textContent, 'Unverified files were not delivered')
    assert.doesNotMatch(completionState?.parentElement?.className || '', /border|dashed/)
    assert.equal(rootElement.querySelector('[data-testid="artifact-open-card"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

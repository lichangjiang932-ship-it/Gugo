import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

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

test('assistant keeps narration and tools in true DOM order with command details collapsed by default', async () => {
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
    const runningToggle = timelines[1].querySelector('[data-testid="tool-step-toggle"]')
    assert.equal(runningToggle?.getAttribute('aria-expanded'), 'false')
    assert.equal(timelines[1].querySelector('[data-testid="tool-step-details"]'), null)
    await act(async () => runningToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(runningToggle.getAttribute('aria-expanded'), 'true')
    assert.match(timelines[1].querySelector('[data-testid="tool-detail-arguments"]')?.textContent || '', /npm test/)
    assert.match(timelines[1].querySelector('[data-testid="tool-live-output"]')?.textContent || '', /3 tests passed/)
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

    const executionToggle = rootElement.querySelector('[data-testid="execution-toggle"]')
    assert.equal(executionToggle?.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-testid="execution-content"]'), null)
    await act(async () => executionToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const fileButton = rootElement.querySelector('[data-testid="tool-summary-open"]')
    assert.equal(executionToggle.getAttribute('aria-expanded'), 'true')
    assert.ok(rootElement.querySelector('[data-testid="execution-content"]'))
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
    assert.equal(rootElement.querySelector('[data-testid="execution-content"]'), null)
    await act(async () => executionToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(executionToggle.getAttribute('aria-expanded'), 'true')
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

test('reasoning-only completion uses a thought label without exposing private reasoning', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const startedAt = Date.now() - 1500
  const msg = {
    id: 'assistant-reasoning-only',
    role: 'assistant',
    content: 'Safe final answer.',
    timestamp: startedAt,
    meta: {
      streaming: false,
      latency: 1500,
      reasoning: 'private chain-of-thought must stay hidden',
    },
  }
  const t = (key, values = {}) => {
    if (key === 'chatMessages.execution') return 'Execution'
    if (key === 'chatMessages.reasoningActive') return 'Thinking'
    if (key === 'chatMessages.reasoningCompleted') return 'Thought'
    if (key === 'chatMessages.durationSeconds') return `${values.seconds}s`
    if (key === 'chatMessages.durationLessThanSecond') return '<1s'
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

    const executionToggle = rootElement.querySelector('[data-testid="execution-toggle"]')
    assert.match(executionToggle?.textContent || '', /Thought · 1s/)
    assert.doesNotMatch(executionToggle?.textContent || '', /Execution/)
    await act(async () => executionToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.doesNotMatch(rootElement.textContent, /private chain-of-thought/)
    assert.match(rootElement.textContent, /Safe final answer/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('execution disclosure auto-collapses after completion and preserves later manual expansion', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const startedAt = Date.now() - 2400
  const baseMessage = {
    id: 'assistant-stable-execution',
    role: 'assistant',
    content: 'Working on it.',
    timestamp: startedAt,
    meta: {
      streaming: true,
      turnStartedAt: startedAt,
      toolCalls: [{
        id: 'stable-tool',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
        status: 'running',
        textOffset: 0,
      }],
    },
  }
  const t = (key, values = {}) => {
    if (key === 'chatMessages.execution') return 'Execution'
    if (key === 'chatMessages.durationSeconds') return `${values.seconds}s`
    if (key === 'chatMessages.durationLessThanSecond') return '<1s'
    if (key === 'chatMessages.executionToolCount') return `${values.count} tools`
    return key
  }
  const renderMessage = (msg, generatingMessageId) => act(async () => root.render(
    <I18nProvider>
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId={generatingMessageId}
        lang="en"
        t={t}
      />
    </I18nProvider>,
  ))

  try {
    await renderMessage(baseMessage, baseMessage.id)
    const runningToggle = rootElement.querySelector('[data-testid="execution-toggle"]')
    const runningContent = rootElement.querySelector('[data-testid="execution-content"]')
    assert.equal(runningToggle?.getAttribute('aria-expanded'), 'true')
    assert.ok(runningContent)

    await renderMessage({
      ...baseMessage,
      meta: {
        ...baseMessage.meta,
        streaming: false,
        latency: 2400,
        toolCalls: [{ ...baseMessage.meta.toolCalls[0], status: 'success', result: '{}' }],
      },
    }, '')

    const completedToggle = rootElement.querySelector('[data-testid="execution-toggle"]')
    assert.equal(completedToggle, runningToggle)
    assert.equal(completedToggle?.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-testid="execution-content"]'), null)
    assert.match(completedToggle?.textContent || '', /Execution · 2s · 1 tools/)
    assert.match(rootElement.querySelector('.chat-assistant-answer')?.textContent || '', /Working on it/)

    await act(async () => completedToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const manuallyExpandedContent = rootElement.querySelector('[data-testid="execution-content"]')
    assert.equal(completedToggle.getAttribute('aria-expanded'), 'true')
    assert.ok(manuallyExpandedContent)

    await renderMessage({
      ...baseMessage,
      content: 'Working on it. Final answer.',
      meta: {
        ...baseMessage.meta,
        streaming: false,
        latency: 2400,
        toolCalls: [{ ...baseMessage.meta.toolCalls[0], status: 'success', result: '{}' }],
      },
    }, '')
    assert.equal(rootElement.querySelector('[data-testid="execution-toggle"]')?.getAttribute('aria-expanded'), 'true')
    assert.equal(rootElement.querySelector('[data-testid="execution-content"]'), manuallyExpandedContent)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

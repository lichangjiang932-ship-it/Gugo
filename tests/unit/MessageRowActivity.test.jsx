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

test('unknown side-effect block clearly stops automatic retry and links to recovery settings', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const copy = {
    'chatMessages.sideEffectUnknownTitle': 'Operation outcome unknown; automatic retry stopped',
    'chatMessages.sideEffectUnknownBody': 'Verify the real outcome in Settings → Operation recovery. It will not run again until you confirm.',
    'chatMessages.openSideEffectRecovery': 'Open Settings → Operation recovery',
  }
  const msg = {
    id: 'assistant-side-effect-unknown',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    meta: {
      serverTurnId: 'turn-side-effect-unknown',
      serverRecoveryBlocked: true,
      serverRecoveryKind: 'side_effect_outcome_unknown',
      serverConnectionState: 'blocked',
    },
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow msg={msg} rowKey={msg.id} generatingMessageId="" lang="en" t={(key) => copy[key] || key} />
      </I18nProvider>,
    ))
    const card = rootElement.querySelector('[data-testid="side-effect-recovery-blocked"]')
    assert.ok(card)
    assert.match(card.textContent, /automatic retry stopped/)
    assert.match(card.textContent, /It will not run again until you confirm/)
    assert.equal(card.querySelector('a')?.getAttribute('href'), '#/settings?tab=recovery')

    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={{
            ...msg,
            meta: { ...msg.meta, serverConnectionState: 'reconnecting' },
          }}
          rowKey={msg.id}
          generatingMessageId=""
          lang="en"
          t={(key) => copy[key] || key}
        />
      </I18nProvider>,
    ))
    assert.equal(rootElement.querySelector('[data-testid="side-effect-recovery-blocked"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

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

test('completed plain assistant turn does not place elapsed chrome before the answer', async () => {
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

    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
    assert.match(rootElement.textContent, /The task is complete/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a sub-second plain turn also keeps timing out of the answer body', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-sub-second-duration',
    role: 'assistant',
    content: 'Fast response.',
    timestamp: 100_000,
    meta: {
      serverTurnId: 'turn-sub-second-duration',
      latency: 223,
    },
  }
  const t = (key, values = {}) => {
    if (key === 'chatMessages.elapsed') return `Elapsed ${values.value}`
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

    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
    assert.match(rootElement.textContent, /Fast response/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a preflight failure without timing or file evidence shows neither zero seconds nor a file receipt', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let manageModelsCount = 0
  const msg = {
    id: 'assistant-preflight-failure',
    role: 'assistant',
    content: 'Configure a model before sending.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      executionStarted: false,
      latency: null,
      turnCompletedAt: null,
      serverFailure: { code: 'MODEL_CONFIG_MISSING' },
      serverTurnId: 'turn-preflight-failure',
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
          onManageModels={() => { manageModelsCount += 1 }}
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="reply-completion-state"]'), null)
    assert.doesNotMatch(rootElement.textContent, /null\s*ms|0\s*(?:s|seconds?)/i)
    assert.ok(rootElement.querySelector('[data-testid="model-setup-error-card"]'))
    await act(async () => rootElement.querySelector('[data-testid="open-model-settings"]').click())
    assert.equal(manageModelsCount, 1)
    assert.match(rootElement.textContent, /Configure a model before sending/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a runtime shutdown handoff says the message was not sent without showing elapsed time', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-runtime-handoff',
    role: 'assistant',
    content: 'The local runtime is restarting. The message was not sent; retry shortly.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      latency: 0,
      serverFailure: { code: 'TURN_ENGINE_SHUTTING_DOWN', action: 'retry' },
      serverTurnId: 'turn-runtime-handoff',
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
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="reply-completion-state"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="model-setup-error-card"]'), null)
    assert.match(rootElement.textContent, /message was not sent/i)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a runtime restart action opens diagnostics and cannot resend the message', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-runtime-configuration',
    role: 'assistant',
    content: 'The local runtime is not configured.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      executionStarted: false,
      serverFailure: {
        code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
        action: 'restart_runtime',
      },
      serverTurnId: 'turn-runtime-configuration',
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
          onRetryModelFailure={() => assert.fail('restart_runtime must not resend')}
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    assert.ok(rootElement.querySelector('[data-testid="runtime-recovery-error-card"]'))
    assert.equal(
      rootElement.querySelector('[data-testid="open-runtime-diagnostics"]')?.getAttribute('href'),
      '#/settings?tab=about',
    )
    assert.equal(rootElement.querySelector('[data-testid="retry-model-request"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an in-flight runtime shutdown is an interruption, not an unsent message or safe resend', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-runtime-interrupted',
    role: 'assistant',
    content: 'The local runtime stopped during execution. Completed progress was preserved.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      executionStarted: true,
      latency: 1_200,
      serverFailure: { code: 'TURN_ENGINE_SHUTDOWN' },
      serverTurnId: 'turn-runtime-interrupted',
    },
  }
  const t = (key, values = {}) => {
    if (key === 'chatMessages.elapsed') return `Elapsed ${values.value}`
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
          onRetryModelFailure={() => assert.fail('an in-flight interruption must not be resent')}
          t={t}
        />
      </I18nProvider>,
    ))

    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="retry-model-request"]'), null)
    assert.doesNotMatch(rootElement.textContent, /message was not sent/i)
    assert.match(rootElement.textContent, /stopped during execution/i)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('only a model pre-execution failure exposes the guarded resend action', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const retried = []
  const baseMessage = {
    id: 'assistant-model-preflight',
    role: 'assistant',
    content: 'Configure a model before sending.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      serverFailure: { code: 'MODEL_CONFIG_MISSING' },
    },
  }
  const renderMessage = async (msg) => {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow
          msg={msg}
          rowKey={msg.id}
          generatingMessageId=""
          lang="en"
          onRetryModelFailure={(value) => retried.push(value.id)}
          t={(key) => key}
        />
      </I18nProvider>,
    ))
  }

  try {
    await renderMessage(baseMessage)
    const retry = rootElement.querySelector('[data-testid="retry-model-request"]')
    assert.ok(retry)
    await act(async () => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    assert.deepEqual(retried, [baseMessage.id])

    await renderMessage({
      ...baseMessage,
      meta: { ...baseMessage.meta, toolCalls: [{ id: 'call-1', name: 'write_file' }] },
    })
    assert.equal(rootElement.querySelector('[data-testid="retry-model-request"]'), null)

    await renderMessage({
      ...baseMessage,
      meta: { ...baseMessage.meta, serverFailure: { code: 'TURN_FAILED' } },
    })
    assert.equal(rootElement.querySelector('[data-testid="retry-model-request"]'), null)

    for (const meta of [
      { serverFailure: { code: 'MODEL_TIMEOUT' } },
      { serverFailure: { code: 'MODEL_AUTH_FAILED' } },
      { serverFailure: { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN' } },
      {
        serverFailure: { code: 'MODEL_CONFIG_MISSING' },
        serverRecoveryBlocked: true,
        serverRecoveryKind: 'model_request_outcome_unknown',
        serverRecoveryModelRequestId: 'mr_unknown',
      },
    ]) {
      await renderMessage({ ...baseMessage, meta: { ...baseMessage.meta, ...meta } })
      assert.equal(rootElement.querySelector('[data-testid="retry-model-request"]'), null)
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('runtime model setup failures keep the actionable settings card without exposing resend', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-model-auth-failure',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    meta: {
      failed: true,
      latency: 1_250,
      serverTurnId: 'turn-model-auth-failure',
      serverFailure: { code: 'MODEL_AUTH_FAILED' },
    },
  }
  const t = (key, values = {}) => {
    if (key === 'errors.modelConfigurationFailure') return 'Model setup needs attention.'
    if (key === 'errors.modelAuthenticationFailed') return 'The model service rejected its credentials.'
    if (key === 'chatMessages.elapsed') return `Elapsed ${values.value}`
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
          onRetryModelFailure={() => assert.fail('runtime failures must not be resent')}
          t={t}
        />
      </I18nProvider>,
    ))

    const card = rootElement.querySelector('[data-testid="model-setup-error-card"]')
    assert.ok(card)
    assert.match(card.textContent, /Model setup needs attention/)
    assert.match(card.textContent, /rejected its credentials/)
    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="retry-model-request"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="reply-completion-state"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('successful assistant text that mentions a model outage is never rewritten as a setup error', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-model-outage-explanation',
    role: 'assistant',
    content: 'A model endpoint can be unavailable during provider maintenance.',
    timestamp: Date.now(),
    meta: { type: 'model_reply' },
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageRow msg={msg} rowKey={msg.id} generatingMessageId="" lang="en" t={(key) => key} />
      </I18nProvider>,
    ))

    assert.equal(rootElement.querySelector('[data-testid="model-setup-error-card"]'), null)
    assert.match(rootElement.textContent, /model endpoint can be unavailable/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an ordinary chat failure does not invent a missing-file receipt', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-runtime-failure',
    role: 'assistant',
    content: 'The model connection was interrupted.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      latency: 1200,
      serverFailure: { code: 'TURN_FAILED' },
      serverTurnId: 'turn-runtime-failure',
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
          t={(key) => key}
        />
      </I18nProvider>,
    ))

    assert.equal(rootElement.querySelector('[data-testid="reply-completion-state"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a failed file task without receipts keeps its missing-file completion state', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-file-failure',
    role: 'assistant',
    content: 'The requested document could not be generated.',
    timestamp: Date.now(),
    meta: {
      failed: true,
      latency: 1200,
      artifactType: 'docx',
      serverFailure: { code: 'ARTIFACT_NOT_CREATED' },
      serverTurnId: 'turn-file-failure',
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
            ? 'No file was generated. Review the error above, then try again.'
            : key}
        />
      </I18nProvider>,
    ))

    assert.equal(
      rootElement.querySelector('[data-testid="reply-completion-state"]')?.textContent,
      'No file was generated. Review the error above, then try again.',
    )
    assert.doesNotMatch(rootElement.textContent, /local file receipts?/i)
    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
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

test('an interrupted resumable turn keeps committed local receipts visible', async () => {
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
      retainedLocalFiles: [{
        id: 'retained-report',
        path: 'D:\\work\\retained-report.pdf',
        filename: 'retained-report.pdf',
        retainedAt: Date.now(),
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
    const receipt = rootElement.querySelector('[data-testid="artifact-open-card"]')
    assert.ok(receipt)
    assert.match(receipt.textContent, /retained-report\.pdf/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a failed turn hides managed artifacts but exposes independently verified local modifications', async () => {
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
      serverTurnId: 'turn-partial-delivery',
      serverArtifacts: [{
        id: 'delivered-html',
        filename: 'gallery.html',
        type: 'html',
        url: '/api/artifacts/delivered-html',
      }],
      serverDeliveryArtifactIds: ['delivered-html'],
      verifiedLocalFiles: [{
        id: 'verified-gallery',
        path: 'D:\\work\\gallery.html',
        filename: 'gallery.html',
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
          t={(key) => key === 'chatMessages.replyPartiallyCompleted'
            ? 'Artifact validation failed, but verified edits were retained'
            : key}
        />
      </I18nProvider>,
    ))

    const completionState = rootElement.querySelector('[data-testid="reply-completion-state"]')
    assert.equal(completionState?.textContent, 'Artifact validation failed, but verified edits were retained')
    assert.doesNotMatch(completionState?.parentElement?.className || '', /border|dashed/)
    const cards = [...rootElement.querySelectorAll('[data-testid="artifact-open-card"]')]
    assert.equal(cards.length, 1)
    assert.match(cards[0].textContent, /gallery\.html/)
    assert.doesNotMatch(cards[0].textContent, /delivered-html/)
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

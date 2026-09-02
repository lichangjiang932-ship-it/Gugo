import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

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

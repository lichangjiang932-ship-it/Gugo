import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import { normalizeServerSessionSnapshot } from '../../src/lib/turnClient.js'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

test('failed snapshot messages derive localized copy without replacing durable partial text', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const serverMessage = '任务未全部完成，但已保存的文件仍可打开；请按文件旁的状态确认结果。'
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-incomplete:assistant',
      role: 'assistant',
      // Legacy servers persisted their localized fallback in assistant
      // content. It remains durable, but must not be rendered as model text.
      content: serverMessage,
      createdAt: 1,
      modelContext: {
        turnId: 'turn-incomplete',
        turnEvidence: true,
        evidenceState: 'failed',
        error: {
          code: 'TURN_INCOMPLETE',
          retryable: true,
        },
      },
    }],
  })
  const failedMessage = snapshot.messages[0]
  const copy = {
    en: {
      failed: translateKey('errors.chatFailure', 'en'),
      incomplete: translateKey('errors.turnIncomplete', 'en'),
    },
    ja: {
      failed: translateKey('errors.chatFailure', 'ja'),
      incomplete: translateKey('errors.turnIncomplete', 'ja'),
    },
  }
  const renderMessage = (msg, lang) => act(async () => root.render(
    <I18nProvider>
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang={lang}
        t={(key) => translateKey(key, lang)}
      />
    </I18nProvider>,
  ))

  try {
    assert.equal(failedMessage.content, serverMessage)
    assert.equal(failedMessage.meta.serverPartialText, '')
    assert.equal(failedMessage.meta.serverFailure.code, 'TURN_INCOMPLETE')

    await renderMessage(failedMessage, 'en')
    assert.equal(rootElement.querySelector('.chat-assistant-answer')?.textContent, copy.en.incomplete)
    assert.doesNotMatch(rootElement.textContent, new RegExp(serverMessage))
    assert.equal(failedMessage.content, serverMessage)

    const genericFailure = {
      ...failedMessage,
      id: 'turn-failed:assistant',
      meta: {
        ...failedMessage.meta,
        serverFailure: {
          code: 'TURN_FAILED',
          message: 'internal server failure detail',
          retryable: false,
        },
      },
    }
    await renderMessage(genericFailure, 'en')
    assert.equal(rootElement.querySelector('.chat-assistant-answer')?.textContent, copy.en.failed)
    assert.doesNotMatch(rootElement.textContent, /internal server failure detail/)

    await renderMessage(failedMessage, 'ja')
    assert.equal(rootElement.querySelector('.chat-assistant-answer')?.textContent, copy.ja.incomplete)
    assert.doesNotMatch(rootElement.textContent, new RegExp(serverMessage))
    assert.equal(failedMessage.content, serverMessage)

    const partialText = 'Verified partial result from the model.'
    await renderMessage({
      ...failedMessage,
      content: `${partialText}\n\n${copy.en.incomplete}`,
      meta: { ...failedMessage.meta, serverPartialText: partialText },
    }, 'ja')
    assert.equal(rootElement.querySelector('.chat-assistant-answer')?.textContent, partialText)
    assert.doesNotMatch(rootElement.textContent, new RegExp(copy.en.incomplete))
    assert.doesNotMatch(rootElement.textContent, new RegExp(copy.ja.incomplete))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a permanent failed-retry rejection keeps partial output and appends its localized cause', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const partialText = 'Verified partial result from the model.'
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-failed-retry:assistant',
      role: 'assistant',
      content: partialText,
      createdAt: 1,
      modelContext: {
        turnId: 'turn-failed-retry',
        turnEvidence: true,
        evidenceState: 'failed',
        serverLastSequence: 7,
        error: {
          code: 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
          retryable: false,
          status: 409,
        },
        failedRetryRejection: {
          code: 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
          failureSequence: 7,
        },
      },
    }],
  })
  const msg = snapshot.messages[0]
  const renderMessage = (lang) => act(async () => root.render(
    <I18nProvider>
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang={lang}
        t={(key) => translateKey(key, lang)}
      />
    </I18nProvider>,
  ))

  try {
    assert.equal(msg.meta.serverPartialText, partialText)
    const englishCause = translateKey('errors.turnFailedRetryCheckpointRequired', 'en')
    const chineseCause = translateKey('errors.turnFailedRetryCheckpointRequired', 'zh')
    const legacyJapaneseCause = translateKey('errors.turnFailedRetryCheckpointRequired', 'ja')
    assert.equal(legacyJapaneseCause, englishCause)

    await renderMessage('en')
    assert.match(rootElement.querySelector('.chat-assistant-answer')?.textContent || '', new RegExp(partialText))
    assert.match(rootElement.querySelector('.chat-assistant-answer')?.textContent || '', new RegExp(englishCause))
    assert.doesNotMatch(rootElement.textContent, new RegExp(translateKey('errors.chatFailure', 'en')))

    await renderMessage('zh')
    assert.match(rootElement.querySelector('.chat-assistant-answer')?.textContent || '', new RegExp(partialText))
    assert.match(rootElement.querySelector('.chat-assistant-answer')?.textContent || '', new RegExp(chineseCause))
    assert.doesNotMatch(rootElement.textContent, new RegExp(englishCause))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('legacy interrupted, cancelled, and recovery-blocked snapshots never render server fallback prose as assistant text', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const interruptedFallback = '任务中断：后续模型请求未能继续，任务尚未完成。请重试以继续。\n\n已经完成的部分：\n- read_file：路径：README.md'
  const blockedFallback = '模型请求可能已被上游接受，系统已阻止自动重试。'
  const cancelledFallback = 'Cancelled by user'
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'legacy-interrupted:assistant',
      role: 'assistant',
      content: interruptedFallback,
      createdAt: 1,
      modelContext: {
        turnId: 'legacy-interrupted',
        turnEvidence: true,
        evidenceState: 'interrupted',
        error: {
          code: 'MODEL_CALL_INTERRUPTED',
          message: '任务执行遇到问题，尚未完成。请重试。',
          retryable: true,
        },
      },
    }, {
      id: 'legacy-blocked:assistant',
      role: 'assistant',
      content: blockedFallback,
      createdAt: 2,
      modelContext: {
        turnId: 'legacy-blocked',
        turnEvidence: true,
        evidenceState: 'blocked',
        error: { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', message: blockedFallback, retryable: false },
        recovery: {
          recoveryKind: 'model_request_outcome_unknown',
          requiresUserVerification: true,
          modelRequestId: 'mr_legacy',
          recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
        },
      },
    }, {
      id: 'legacy-cancelled:assistant',
      role: 'assistant',
      content: cancelledFallback,
      createdAt: 3,
      modelContext: {
        turnId: 'legacy-cancelled',
        turnEvidence: true,
        evidenceState: 'cancelled',
      },
    }],
  })
  const renderMessage = (msg, lang = 'en') => act(async () => root.render(
    <I18nProvider>
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang={lang}
        t={(key) => translateKey(key, lang)}
      />
    </I18nProvider>,
  ))

  try {
    const interrupted = snapshot.messages[0]
    assert.equal(interrupted.meta.serverPartialText, '')
    await renderMessage(interrupted, 'en')
    assert.doesNotMatch(rootElement.textContent, new RegExp(interruptedFallback))
    assert.equal(
      rootElement.querySelector('.chat-assistant-answer')?.textContent,
      translateKey('errors.turnModelInterrupted', 'en'),
    )
    await renderMessage(interrupted, 'ja')
    assert.equal(
      rootElement.querySelector('.chat-assistant-answer')?.textContent,
      translateKey('errors.turnModelInterrupted', 'ja'),
    )

    const blocked = snapshot.messages[1]
    assert.equal(blocked.meta.serverPartialText, '')
    await renderMessage(blocked)
    assert.doesNotMatch(rootElement.textContent, new RegExp(blockedFallback))
    assert.ok(rootElement.querySelector('[data-testid="model-request-recovery-blocked"]'))

    const cancelled = snapshot.messages[2]
    assert.equal(cancelled.content, cancelledFallback)
    assert.equal(cancelled.meta.serverPartialText, '')
    await renderMessage(cancelled, 'en')
    assert.equal(
      rootElement.querySelector('.chat-assistant-answer')?.textContent,
      translateKey('chat.serverTurn.cancelled', 'en'),
    )
    assert.doesNotMatch(rootElement.textContent, new RegExp(cancelledFallback))

    await renderMessage(cancelled, 'ja')
    assert.equal(
      rootElement.querySelector('.chat-assistant-answer')?.textContent,
      translateKey('chat.serverTurn.cancelled', 'ja'),
    )

    const partialText = 'The model saved a verified partial draft.'
    await renderMessage({
      ...cancelled,
      meta: { ...cancelled.meta, serverPartialText: partialText },
    }, 'ja')
    assert.equal(rootElement.querySelector('.chat-assistant-answer')?.textContent, partialText)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

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

test('an invalid legacy incomplete reason does not reclassify an ordinary failure', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const rawReason = 'TypeError: secret internal stack'
  const msg = {
    id: 'assistant-invalid-incomplete-reason',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    meta: {
      failed: true,
      serverFailure: {
        code: 'TURN_FAILED',
        incompleteReason: rawReason,
      },
      serverTurnId: 'turn-invalid-incomplete-reason',
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

    assert.equal(rootElement.querySelector('[data-testid="incomplete-task-notice"]'), null)
    assert.doesNotMatch(rootElement.textContent, /secret internal stack/i)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('ordinary recovery blocks render a localized cause instead of an empty terminal reply', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-context-drift',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    meta: {
      serverTurnId: 'turn-context-drift',
      serverRecoveryBlocked: true,
      serverConnectionState: 'blocked',
      serverFailure: {
        code: 'TURN_PERMISSION_CONTEXT_DRIFT',
        retryable: false,
      },
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
          t={(key) => key === 'errors.turnExecutionContextChanged'
            ? 'The saved execution context changed; verify it before continuing.'
            : key}
        />
      </I18nProvider>,
    ))

    assert.equal(
      rootElement.querySelector('.chat-assistant-answer')?.textContent,
      'The saved execution context changed; verify it before continuing.',
    )
    assert.equal(rootElement.querySelector('[data-testid="side-effect-recovery-blocked"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="model-request-recovery-blocked"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

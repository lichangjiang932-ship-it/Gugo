import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

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
          t={(key) => ({
            'chatMessages.incompleteTitle': 'Task incomplete',
            'chatMessages.incompleteReasonLabel': 'Why:',
            'chatMessages.incompleteMissingLabel': 'Still needed:',
            'chatMessages.incompleteNextStepLabel': 'Next:',
            'chatMessages.incompleteReasonFallback': 'No detailed terminal reason was retained.',
            'chatMessages.incompleteRequirementArtifact': 'a validated final file',
            'chatMessages.incompleteNextAdjust': 'Review the missing requirements and continue.',
            'chatMessages.incompleteListSeparator': '; ',
          }[key] || key)}
        />
      </I18nProvider>,
    ))

    assert.equal(
      rootElement.querySelector('[data-testid="reply-completion-state"]')?.textContent,
      'Task incomplete',
    )
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-reason"]')?.textContent || '', /No detailed terminal reason was retained/)
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-missing"]')?.textContent || '', /validated final file/)
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-next-step"]')?.textContent || '', /Review the missing requirements/)
    assert.doesNotMatch(rootElement.textContent, /local file receipts?/i)
    assert.equal(rootElement.querySelector('[data-testid="task-duration-header"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a live model reply exposes structured incomplete diagnostics even without file receipts', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'assistant-live-incomplete',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    meta: {
      type: 'model_reply',
      failed: true,
      serverTurnId: 'turn-live-incomplete',
      serverFailure: {
        code: 'TURN_INCOMPLETE',
        incompleteReason: 'execution_budget_exhausted',
        missingRequirements: ['remaining_task_steps'],
        retryable: true,
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
          t={(key) => ({
            'chatMessages.incompleteTitle': 'Task incomplete',
            'chatMessages.incompleteReasonLabel': 'Why:',
            'chatMessages.incompleteMissingLabel': 'Still needed:',
            'chatMessages.incompleteNextStepLabel': 'Next:',
            'chatMessages.incompleteReasonBudget': 'The execution budget was exhausted.',
            'chatMessages.incompleteRequirementRemainingSteps': 'unfinished task steps',
            'chatMessages.incompleteNextRetry': 'Continue from the checkpoint.',
            'chatMessages.incompleteListSeparator': '; ',
          }[key] || key)}
        />
      </I18nProvider>,
    ))

    assert.equal(
      rootElement.querySelector('[data-testid="reply-completion-state"]')?.textContent,
      'Task incomplete',
    )
    assert.match(
      rootElement.querySelector('[data-testid="incomplete-task-reason"]')?.textContent || '',
      /execution budget was exhausted/i,
    )
    assert.match(
      rootElement.querySelector('[data-testid="incomplete-task-missing"]')?.textContent || '',
      /unfinished task steps/i,
    )
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
      serverFailure: {
        code: 'TURN_INTERRUPTED',
        incompleteReason: 'model_call_interrupted',
        missingRequirements: ['task_completion'],
        retryable: true,
      },
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
    assert.ok(rootElement.querySelector('[data-testid="reply-completion-state"]'))
    assert.ok(rootElement.querySelector('[data-testid="incomplete-task-reason"]'))
    assert.ok(rootElement.querySelector('[data-testid="incomplete-task-missing"]'))
    assert.ok(rootElement.querySelector('[data-testid="incomplete-task-next-step"]'))
    assert.ok(rootElement.querySelector('[data-testid="incomplete-task-file-state"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('blocked and generic model failures with local receipts show structured incomplete state', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const cases = [{
    id: 'assistant-blocked-receipt',
    meta: {
      failed: false,
      serverTurnId: 'turn-blocked-receipt',
      serverConnectionState: 'blocked',
      serverFailure: { code: 'TURN_RECOVERY_BLOCKED', manualRetryable: true },
      retainedLocalFiles: [{
        id: 'blocked-file',
        path: 'D:\\work\\blocked.html',
        filename: 'blocked.html',
      }],
    },
  }, {
    id: 'assistant-generic-failed-receipt',
    meta: {
      type: 'model_reply',
      failed: true,
      serverTurnId: 'turn-generic-failed-receipt',
      serverFailure: { code: 'TURN_FAILED', retryable: false },
      verifiedLocalFiles: [{
        id: 'failed-file',
        path: 'D:\\work\\failed.html',
        filename: 'failed.html',
      }],
    },
  }]

  try {
    for (const entry of cases) {
      const msg = {
        id: entry.id,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        meta: entry.meta,
      }
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

      assert.ok(rootElement.querySelector('[data-testid="reply-completion-state"]'), entry.id)
      assert.ok(rootElement.querySelector('[data-testid="incomplete-task-reason"]'), entry.id)
      assert.ok(rootElement.querySelector('[data-testid="incomplete-task-missing"]'), entry.id)
      assert.ok(rootElement.querySelector('[data-testid="incomplete-task-next-step"]'), entry.id)
      assert.ok(rootElement.querySelector('[data-testid="incomplete-task-file-state"]'), entry.id)
    }
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
      serverFailure: {
        code: 'TURN_INCOMPLETE',
        incompleteReason: 'post_mutation_verification_missing',
        missingRequirements: ['mutation_readback', 'diff_or_project_check'],
        retryable: true,
      },
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
          t={(key, values = {}) => ({
            'chatMessages.incompleteTitle': 'Task incomplete',
            'chatMessages.incompleteReasonLabel': 'Why:',
            'chatMessages.incompleteMissingLabel': 'Still needed:',
            'chatMessages.incompleteNextStepLabel': 'Next:',
            'chatMessages.incompleteReasonMutationVerification': 'Changes were written but acceptance checks did not finish.',
            'chatMessages.incompleteRequirementReadback': 'modified-file read-back',
            'chatMessages.incompleteRequirementProjectCheck': 'diff or project checks',
            'chatMessages.incompleteNextRetry': 'Continue from the checkpoint.',
            'chatMessages.incompleteVerifiedFiles': `${values.count} verified file`,
            'chatMessages.incompleteListSeparator': '; ',
          }[key] || key)}
        />
      </I18nProvider>,
    ))

    const completionState = rootElement.querySelector('[data-testid="reply-completion-state"]')
    assert.equal(completionState?.textContent, 'Task incomplete')
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-reason"]')?.textContent || '', /acceptance checks did not finish/)
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-missing"]')?.textContent || '', /modified-file read-back.*diff or project checks/)
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-next-step"]')?.textContent || '', /Continue from the checkpoint/)
    assert.match(rootElement.querySelector('[data-testid="incomplete-task-file-state"]')?.textContent || '', /1 verified file/)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

const t = (key, values = {}) => translateKey(key, 'zh').replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match)
const message = {
  id: 'interrupted-model:assistant', role: 'assistant', content: '', createdAt: 1,
  meta: { failed: true, serverTurnId: 'interrupted-model', serverConnectionState: 'blocked',
    serverRecoveryBlocked: true, serverRecoveryKind: 'model_request_outcome_unknown',
    serverRecoveryModelRequestId: 'mr_interrupted', serverPartialText: '',
    serverFailure: { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', incompleteReason: 'model_request_outcome_unknown',
      missingRequirements: ['operation_outcome_verification'], retryable: false, manualRetryable: true,
      modelRequestDiagnostics: { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', timeoutPhase: 'idle', timeoutMs: 180_000,
        partialContentChars: 0, contentRetained: false, cause: { message: 'SECRET_INTERNAL_DETAILS' } },
    },
  },
}

async function inspect(msg, check) {
  const dom = setupDom()
  const container = document.getElementById('root')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MessageRow msg={msg} rowKey={msg.id}
      generatingMessageId="" lang="zh" t={t} /></I18nProvider>))
    check(container)
  } finally { await act(async () => root.unmount()); dom.window.close() }
}

test('a model interruption without local file evidence shows one diagnostic notice instead of duplicate task warnings', async () => {
  await inspect(message, (container) => {
    const notice = container.querySelector('[data-testid="model-request-recovery-blocked"]')
    assert.ok(notice)
    assert.match(notice.textContent, /等待模型输出超时/)
    assert.match(notice.textContent, /180 秒/)
    assert.equal(container.querySelector('[data-testid="incomplete-task-notice"]'), null)
    assert.doesNotMatch(container.textContent, /SECRET_INTERNAL_DETAILS|确认上一次模型请求或写入操作/)
    assert.match(notice.querySelector('a').getAttribute('href'), /modelRequestId=mr_interrupted/)
  })
})

test('verified file receipts remain visible when the model fails after completed local work', async () => {
  await inspect({ ...message, meta: { ...message.meta, verifiedLocalFiles: [{
    id: 'local-file-verified-result', path: 'D:\\workspace\\result.txt', filename: 'result.txt', size: 10, verifiedAt: 1,
  }] } }, (container) => {
    assert.ok(container.querySelector('[data-testid="model-request-recovery-blocked"]'))
    const receipt = container.querySelector('[data-testid="incomplete-verified-files"]')
    assert.ok(receipt, 'deduplication must not discard verified local file evidence')
    assert.match(receipt.textContent, /result\.txt/)
    assert.match(container.querySelector('[data-testid="incomplete-task-missing"]').textContent, /模型请求的上游结果/)
  })
})

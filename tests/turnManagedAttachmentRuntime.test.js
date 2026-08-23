import assert from 'node:assert/strict'
import test from 'node:test'
import {
  missingAttachmentBindingRuntime,
  missingAttachmentPreparationRuntime,
  missingAttachmentValidationRuntime,
} from '../server/services/turnManagedAttachmentRuntime.js'

test('missing managed attachment runtime remains inert when a turn has no attachments', () => {
  assert.deepEqual(missingAttachmentValidationRuntime(), [])
  assert.deepEqual(missingAttachmentBindingRuntime({ attachmentIds: null }), [])
  assert.deepEqual(
    missingAttachmentPreparationRuntime({ attachmentIds: [], text: 'plain message' }),
    { attachments: [], content: 'plain message' },
  )
})

test('missing managed attachment runtime fails closed when attachments are requested', () => {
  for (const runtime of [
    missingAttachmentValidationRuntime,
    missingAttachmentBindingRuntime,
    missingAttachmentPreparationRuntime,
  ]) {
    assert.throws(
      () => runtime({ attachmentIds: ['attachment-1'], text: 'inspect' }),
      (error) => error?.code === 'MANAGED_ATTACHMENT_PORT_NOT_CONFIGURED'
        && error?.status === 503
        && error?.retryable === false,
    )
  }
})

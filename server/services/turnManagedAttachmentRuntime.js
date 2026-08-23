import { TurnEngineError } from './turnResolutionRuntime.js'

function managedAttachmentPortNotConfigured() {
  const error = new TurnEngineError(
    'MANAGED_ATTACHMENT_PORT_NOT_CONFIGURED',
    'Managed attachment runtime must be configured by the host before attachments are used',
    503,
  )
  error.retryable = false
  throw error
}

export function missingAttachmentValidationRuntime({ attachmentIds = [] } = {}) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return []
  return managedAttachmentPortNotConfigured()
}

export function missingAttachmentBindingRuntime({ attachmentIds = [] } = {}) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return []
  return managedAttachmentPortNotConfigured()
}

export function missingAttachmentPreparationRuntime({ attachmentIds = [], text = '' } = {}) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    return { attachments: [], content: String(text || '') }
  }
  return managedAttachmentPortNotConfigured()
}

export const MAX_ATTACHMENTS = 32
export const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024
export const MAX_INLINE_BYTES = 20 * 1024 * 1024
export const MAX_CONTENT_PARTS = 128
export const MAX_TEXT_CHARS = 1024 * 1024
export const MAX_TOTAL_CONTENT_CHARS = 64 * 1024 * 1024

export const MANAGED_ATTACHMENT_RUNTIME_BOUNDARY_LIMITS = Object.freeze({
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxInlineBytes: MAX_INLINE_BYTES,
  maxContentParts: MAX_CONTENT_PARTS,
  maxTextChars: MAX_TEXT_CHARS,
  maxTotalContentChars: MAX_TOTAL_CONTENT_CHARS,
})

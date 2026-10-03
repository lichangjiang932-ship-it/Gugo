/**
 * Read only authored text parts; never turn file/image metadata into
 * instructions. Works for both user and system-host messages, including
 * typed-content arrays restored from persistence or provider replay.
 */
export function messageTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** @deprecated Use {@link messageTextContent}; kept for the existing call sites. */
export const userMessageText = messageTextContent

/** Read only authored text parts; never turn file/image metadata into instructions. */
export function userMessageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

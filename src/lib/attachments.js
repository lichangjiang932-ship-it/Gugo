export function formatAttachmentForPrompt(attachment) {
  if (attachment.kind === 'text') {
    return `\n\n[附件: ${attachment.name}, ${attachment.sizeKB} KB]\n\`\`\`\n${attachment.text}\n\`\`\``
  }
  return `\n\n[附件: ${attachment.name}, ${attachment.sizeKB} KB, 类型: ${attachment.type || 'unknown'}]`
}

export function buildUserContentWithAttachments(prompt, attachments = []) {
  const textAttachments = attachments
    .filter((item) => item.kind !== 'image')
    .map(formatAttachmentForPrompt)
    .join('')
  const text = `${prompt || '请分析附件内容。'}${textAttachments}`
  const images = attachments.filter((item) => item.kind === 'image' && item.dataUrl)
  if (!images.length) return text
  return [
    { type: 'text', text },
    ...images.map((item) => ({
      type: 'image_url',
      image_url: { url: item.dataUrl },
    })),
  ]
}

export function describeAttachmentPrompt(attachments = []) {
  if (!attachments.length) return ''
  const names = attachments.map((item) => item.name).filter(Boolean).slice(0, 4).join('、')
  const suffix = attachments.length > 4 ? ` 等 ${attachments.length} 个附件` : ''
  return `请分析附件：${names}${suffix}`
}

export function formatAttachmentForPrompt(attachment) {
  if (attachment.kind === 'text' || attachment.kind === 'pdf') {
    return `\n\n[附件: ${attachment.name}, ${attachment.sizeKB} KB]\n\`\`\`\n${attachment.text}\n\`\`\``
  }
  const ext = attachment.name.split('.').pop()?.toLowerCase()
  const binaryTypes = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'zip', 'epub', 'rtf']
  const note = binaryTypes.includes(ext) ? '（二进制文件，无法直接读取内容）' : ''
  return `\n\n[附件: ${attachment.name}, ${attachment.sizeKB} KB, 类型: ${attachment.type || 'unknown'}${note}]`
}

export function buildUserContentWithAttachments(prompt, attachments = []) {
  const textAttachments = attachments
    .filter((item) => item.kind !== 'image' && item.kind !== 'pdf')
    .map(formatAttachmentForPrompt)
    .join('')
  const text = `${prompt || '请分析附件内容。'}${textAttachments}`
  const images = attachments.filter((item) => item.kind === 'image' && item.dataUrl)
  const pdfs = attachments.filter((item) => item.kind === 'pdf')
  if (!images.length && !pdfs.length) return text
  return [
    { type: 'text', text },
    ...images.map((item) => ({
      type: 'image_url',
      image_url: { url: item.dataUrl },
    })),
    ...pdfs.map((item) => ({
      type: 'yma_pdf',
      filename: item.name,
      file_data: item.dataUrl,
      fallback_text: formatAttachmentForPrompt(item).trim(),
    })),
  ]
}

export function describeAttachmentPrompt(attachments = []) {
  if (!attachments.length) return ''
  const names = attachments.map((item) => item.name).filter(Boolean).slice(0, 4).join('、')
  const suffix = attachments.length > 4 ? ` 等 ${attachments.length} 个附件` : ''
  return `请分析附件：${names}${suffix}`
}

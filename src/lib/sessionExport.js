// ★ #12: 会话导出 — JSON / Markdown 两种格式
// JSON: 原始结构, 适合再导入 / 备份
// Markdown: 人类可读, 适合分享 / 评审

function fmtDate(ts) {
  if (!ts) return ''
  try { return new Date(ts).toISOString().replace('T', ' ').replace(/\..+$/, '') } catch { return '' }
}

function escapeYaml(s) {
  return String(s ?? '').replace(/"/g, '\\"')
}

/**
 * 把 session 转成 markdown 文本.
 * 包含: 标题 / 时间 / 使用模型 / 系统提示 / 每条消息 (role + content + meta).
 * artifact 块用 fenced code 标记原文; 工具调用用列表展开.
 */
export function sessionToMarkdown(session) {
  if (!session) return ''
  const lines = []
  lines.push(`---`)
  lines.push(`title: "${escapeYaml(session.title || '会话')}"`)
  lines.push(`session_id: "${escapeYaml(session.id)}"`)
  if (session.createdAt) lines.push(`created_at: "${fmtDate(session.createdAt)}"`)
  if (session.updatedAt) lines.push(`updated_at: "${fmtDate(session.updatedAt)}"`)
  if (session.model) lines.push(`model: "${escapeYaml(session.model)}"`)
  lines.push(`---`)
  lines.push('')
  lines.push(`# ${session.title || '会话'}`)
  lines.push('')

  const msgs = Array.isArray(session.messages) ? session.messages : []
  msgs.forEach((m, idx) => {
    const role = m.role === 'user' ? '🧑 用户' : m.role === 'assistant' ? '🤖 助手' : `⚙️ ${m.role}`
    lines.push(`## ${idx + 1}. ${role}`)
    if (m.meta?.modelName) lines.push(`*模型: ${m.meta.modelName}*  `)
    if (typeof m.meta?.latency === 'number') lines.push(`*延迟: ${m.meta.latency} ms*  `)
    lines.push('')
    const content = String(m.content || '').trim()
    if (content) {
      lines.push(content)
      lines.push('')
    }
    // 工具调用
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      lines.push(`<details><summary>工具调用 (${m.toolCalls.length})</summary>`)
      lines.push('')
      m.toolCalls.forEach((tc, i) => {
        lines.push(`### tool ${i + 1}: \`${tc.name || tc.id || '?'}\``)
        if (tc.arguments) {
          const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2)
          lines.push('```json')
          lines.push(args)
          lines.push('```')
        }
        if (tc.result !== undefined) {
          const result = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)
          lines.push('```')
          lines.push(result)
          lines.push('```')
        }
      })
      lines.push('')
      lines.push(`</details>`)
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  })

  return lines.join('\n')
}

export function downloadBlob(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportSession(session, format = 'json') {
  if (!session) return
  const safeTitle = String(session.title || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === 'md' || format === 'markdown') {
    downloadBlob(`${safeTitle}-${stamp}.md`, sessionToMarkdown(session), 'text/markdown;charset=utf-8')
  } else {
    downloadBlob(
      `${safeTitle}-${stamp}.json`,
      JSON.stringify(session, null, 2),
      'application/json;charset=utf-8',
    )
  }
}

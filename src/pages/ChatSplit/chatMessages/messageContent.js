export const USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT = 360
export const USER_MESSAGE_COLLAPSE_LINE_LIMIT = 8
export const USER_MESSAGE_PREVIEW_CHARACTER_LIMIT = 240
export const USER_MESSAGE_PREVIEW_LINE_LIMIT = 6

function splitMessageLines(content) {
  return String(content || '').split(/\r\n|\r|\n/u)
}

export function shouldCollapseUserMessage(content = '') {
  const text = String(content || '')
  return Array.from(text).length > USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT
    || splitMessageLines(text).length > USER_MESSAGE_COLLAPSE_LINE_LIMIT
}

export function buildCollapsedUserMessagePreview(content = '') {
  const lines = splitMessageLines(content)
  const lineLimited = lines.slice(0, USER_MESSAGE_PREVIEW_LINE_LIMIT).join('\n')
  const characters = Array.from(lineLimited)
  const preview = characters.length > USER_MESSAGE_PREVIEW_CHARACTER_LIMIT
    ? characters.slice(0, USER_MESSAGE_PREVIEW_CHARACTER_LIMIT).join('')
    : lineLimited
  return preview.trimEnd()
}

export function splitUserSkillCommand(content = '') {
  const raw = String(content || '')
  const match = raw.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  return match ? { command: `/${match[1]}`, body: match[2] || '' } : { command: '', body: raw }
}

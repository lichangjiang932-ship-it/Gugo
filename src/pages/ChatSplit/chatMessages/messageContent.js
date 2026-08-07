export function splitUserSkillCommand(content = '') {
  const raw = String(content || '')
  const match = raw.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  return match ? { command: `/${match[1]}`, body: match[2] || '' } : { command: '', body: raw }
}

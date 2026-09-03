export function splitLeadingSkillCommand(value, skillIds = []) {
  const raw = String(value || '')
  const match = raw.match(/^\/([a-z0-9_-]+)\s([\s\S]*)$/i)
  if (!match) return { command: '', body: raw }
  const known = new Set((Array.isArray(skillIds) ? skillIds : []).map((id) => String(id).toLowerCase()))
  if (!known.has(match[1].toLowerCase())) return { command: '', body: raw }
  return { command: `/${match[1]}`, body: match[2] }
}

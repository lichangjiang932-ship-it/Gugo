/**
 * A project's mark: a stable hue and an initial, derived from its name.
 *
 * A column of identical grey folders makes every project look the same; a
 * colour and a letter let a reader find "their" project by shape before they
 * read it, the way Linear and Slack mark teams. Derived, not stored, so the same
 * name looks the same in the sidebar and in the conversation header, on every
 * machine, with nothing to configure or migrate.
 */
const HUES = Object.freeze([212, 158, 268, 24, 340, 190, 44, 296, 128, 0])

export function projectHue(name) {
  const text = String(name || '').trim().toLowerCase()
  let hash = 0
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) >>> 0
  return HUES[hash % HUES.length]
}

export function projectInitial(name) {
  const text = String(name || '').trim()
  // Projects of one family share a prefix ("gugo-cli-fix", "gugo-cli-smoke"):
  // their first letters are all the same, which defeats the point. The last
  // word of a dashed/underscored name is what tells them apart.
  const words = text.split(/[-_\s.]+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
  const pick = words.length > 1 ? words[words.length - 1] : text
  const match = pick.match(/[\p{L}\p{N}]/u) || text.match(/[\p{L}\p{N}]/u)
  return (match ? match[0] : '#').toUpperCase()
}

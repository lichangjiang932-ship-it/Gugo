export const OFFICIAL_SKILL_PRESETS = Object.freeze([
  Object.freeze({
    id: 'gsap',
    name: 'GSAP',
    repo: 'greensock/gsap-skills',
    url: 'https://github.com/greensock/gsap-skills',
  }),
  Object.freeze({
    id: 'anthropic-skills',
    name: 'Anthropic Skills',
    repo: 'anthropics/skills',
    url: 'https://github.com/anthropics/skills',
  }),
  Object.freeze({
    id: 'superpowers',
    name: 'Superpowers',
    repo: 'obra/superpowers',
    url: 'https://github.com/obra/superpowers',
  }),
  Object.freeze({
    id: 'mattpocock-skills',
    name: 'Matt Pocock Skills',
    repo: 'mattpocock/skills',
    url: 'https://github.com/mattpocock/skills',
  }),
])

export function getOfficialSkillPreset(id) {
  return OFFICIAL_SKILL_PRESETS.find((preset) => preset.id === id) || null
}

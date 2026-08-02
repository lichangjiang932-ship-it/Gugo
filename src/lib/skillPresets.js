export const OFFICIAL_SKILL_PRESETS = Object.freeze([
  Object.freeze({
    id: 'gsap',
    name: 'GSAP',
    repo: 'greensock/gsap-skills',
    url: 'https://github.com/greensock/gsap-skills',
  }),
])

export function getOfficialSkillPreset(id) {
  return OFFICIAL_SKILL_PRESETS.find((preset) => preset.id === id) || null
}

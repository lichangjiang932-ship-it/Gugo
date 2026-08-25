import assert from 'node:assert/strict'
import test from 'node:test'

import { getOfficialSkillPreset, OFFICIAL_SKILL_PRESETS } from '../src/lib/skillPresets.js'

test('official skill presets are well-formed GitHub shortcuts', () => {
  assert.equal(OFFICIAL_SKILL_PRESETS.length, 4)
  const seen = new Set()
  for (const preset of OFFICIAL_SKILL_PRESETS) {
    assert.ok(preset.id && preset.name && preset.repo && preset.url, `${preset.id} has all fields`)
    assert.ok(!seen.has(preset.id), `duplicate preset id ${preset.id}`)
    seen.add(preset.id)
    assert.equal(preset.url, `https://github.com/${preset.repo}`, `${preset.id} url matches repo`)
    assert.ok(/^[^/]+\/[^/]+$/.test(preset.repo), `${preset.id} repo is owner/name`)
  }
})

test('getOfficialSkillPreset resolves known ids and rejects unknown ones', () => {
  assert.equal(getOfficialSkillPreset('gsap')?.repo, 'greensock/gsap-skills')
  assert.equal(getOfficialSkillPreset('anthropic-skills')?.repo, 'anthropics/skills')
  assert.equal(getOfficialSkillPreset('superpowers')?.repo, 'obra/superpowers')
  assert.equal(getOfficialSkillPreset('mattpocock-skills')?.repo, 'mattpocock/skills')
  assert.equal(getOfficialSkillPreset('missing'), null)
})

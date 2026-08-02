import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { getOfficialSkillPreset, OFFICIAL_SKILL_PRESETS } from '../src/lib/skillPresets.js'

test('GSAP official skill preset points to the requested upstream repository', () => {
  assert.equal(OFFICIAL_SKILL_PRESETS.length, 1)
  assert.deepEqual(getOfficialSkillPreset('gsap'), {
    id: 'gsap',
    name: 'GSAP',
    repo: 'greensock/gsap-skills',
    url: 'https://github.com/greensock/gsap-skills',
  })
  assert.equal(getOfficialSkillPreset('missing'), null)
})

test('Skills market exposes the GSAP preset through the existing GitHub importer', () => {
  const source = fs.readFileSync(new URL('../src/pages/SkillsMarket.jsx', import.meta.url), 'utf8')
  assert.match(source, /openGithubImport\('gsap'\)/)
  assert.match(source, /getOfficialSkillPreset/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { loadSeedSkillPackage, SYSTEM_SKILLS_SEED_ROOT } from '../server/services/seedSystemSkills.js'

const EXPECTED = {
  'media-operator': ['media_probe', 'media_transform'],
  'pdf-operator': ['pdf_info', 'pdf_text', 'pdf_transform'],
  'image-operator': ['image_info', 'image_transform'],
  'font-creator': ['bash_exec'],
  'archive-operator': ['archive_list', 'archive_create', 'archive_extract', 'batch_rename', 'file_hash_manifest'],
}

for (const [id, tools] of Object.entries(EXPECTED)) {
  test(`${id} is a valid production seed skill and references its real tools`, () => {
    const dir = path.join(SYSTEM_SKILLS_SEED_ROOT, id)
    const pkg = loadSeedSkillPackage(dir)
    assert.equal(pkg.manifest.id, id)
    assert.equal(pkg.manifest.disabled, undefined)
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${id}`, 'u'))
    for (const tool of tools) assert.match(skill, new RegExp(`\\b${tool}\\b`, 'u'))
  })
}

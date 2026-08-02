import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { SYSTEM_SKILLS_SEED_ROOT } from '../server/services/seedSystemSkills.js'

test('system skill seeding resolves the repository seed/skills directory', () => {
  assert.equal(path.basename(SYSTEM_SKILLS_SEED_ROOT), 'skills')
  assert.equal(path.basename(path.dirname(SYSTEM_SKILLS_SEED_ROOT)), 'seed')
  assert.equal(fs.existsSync(path.join(SYSTEM_SKILLS_SEED_ROOT, 'ppt-master', 'SKILL.md')), true)
})

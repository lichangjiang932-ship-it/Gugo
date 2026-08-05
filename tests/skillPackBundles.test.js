import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { validateSkillPack } from '../server/services/skillImport.js'

const PACKS_ROOT = path.resolve('skill-packs')

function collectFiles(dir, prefix = '') {
  const files = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(files, collectFiles(full, rel))
    else files[rel] = fs.readFileSync(full, 'utf8')
  }
  return files
}

test('every bundled skill-pack passes the import validator', () => {
  const packDirs = fs.existsSync(PACKS_ROOT)
    ? fs.readdirSync(PACKS_ROOT).filter((name) => fs.statSync(path.join(PACKS_ROOT, name)).isDirectory())
    : []
  assert.ok(packDirs.length >= 1, 'skill-packs/ should contain at least one pack')
  for (const name of packDirs) {
    const result = validateSkillPack(collectFiles(path.join(PACKS_ROOT, name)))
    assert.equal(result.ok, true, `${name} pack must pass validation: ${result.reason || ''}`)
    assert.ok(result.skill.id, `${name} must resolve a skill id`)
  }
})

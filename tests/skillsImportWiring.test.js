import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('skills page exposes folder import flow', () => {
  const source = fs.readFileSync(new URL('../src/pages/SkillsMarket.jsx', import.meta.url), 'utf8')
  assert.match(source, /webkitdirectory/)
  assert.match(source, /importSkillPack/)
  assert.match(source, /导入技能包/)
})


import assert from 'node:assert/strict'
import test from 'node:test'
import { projectHue, projectInitial } from '../../src/lib/projectGlyph.js'

test('projects of one family get initials that tell them apart', () => {
  // These share "gugo-cli-": a first-letter initial would make every row a "G".
  const names = ['gugo-cli-fix-DvtiwR', 'gugo-cli-acceptedits-sANx', 'gugo-cli-approval-q5az8G', 'gugo-cli-smoke-O3c6cz', 'gugo-inter']
  assert.deepEqual(names.map(projectInitial), ['D', 'S', 'Q', 'O', 'I'])
  assert.equal(projectInitial('Root'), 'R')
  assert.equal(projectInitial('.dotfiles'), 'D')
  assert.equal(projectInitial('我的项目'), '我')
  assert.equal(projectInitial(''), '#')
})

test('a project keeps the same colour everywhere it is shown', () => {
  assert.equal(projectHue('gugo-inter'), projectHue('gugo-inter'))
  assert.equal(projectHue('Gugo-Inter'), projectHue('gugo-inter'), 'case does not change the colour')
  assert.ok(Number.isInteger(projectHue('')))
})

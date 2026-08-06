import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { isThemeMode, normalizeThemeMode, THEME_MODES, THEME_OPTIONS } from '../../src/lib/themeMode.js'

test('theme modes include a distinct white option', () => {
  assert.deepEqual(THEME_MODES, ['system', 'light', 'white', 'dark'])
  assert.equal(isThemeMode('white'), true)
  assert.equal(normalizeThemeMode('white'), 'white')
  assert.deepEqual(
    THEME_OPTIONS.find((option) => option.key === 'white'),
    { key: 'white', labelKey: 'settings.themeWhite' },
  )
})

test('invalid persisted theme values fall back to white', () => {
  assert.equal(isThemeMode('unknown'), false)
  assert.equal(normalizeThemeMode('unknown'), 'white')
  assert.equal(normalizeThemeMode(null), 'white')
})

test('white theme defines pure-white surface and neutral contrast tokens', () => {
  const css = fs.readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
  const whiteBlock = css.match(/html\[data-theme="white"\]\s*\{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(whiteBlock, /--color-paper:\s*#FFFFFF;/)
  assert.match(whiteBlock, /--color-ink:\s*#171717;/)
  assert.match(whiteBlock, /--color-paper-rgb:\s*255 255 255;/)
})

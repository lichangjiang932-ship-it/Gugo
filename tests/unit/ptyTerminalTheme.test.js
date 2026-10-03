import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseColorChannels,
  resolveTerminalTheme,
  terminalThemeForElement,
  terminalTypographyForElement,
  toRgbString,
} from '../../src/lib/ptyTerminalTheme.js'

test('the colour formats a browser can hand back are all readable', () => {
  assert.deepEqual(parseColorChannels('rgb(31, 41, 55)'), { r: 31, g: 41, b: 55 })
  // getComputedStyle may return the modern space-separated form.
  assert.deepEqual(parseColorChannels('rgb(31 41 55 / 1)'), { r: 31, g: 41, b: 55 })
  // The theme tokens are bare triplets: `--color-ink-rgb: 31 41 55`.
  assert.deepEqual(parseColorChannels(' 31 41 55 '), { r: 31, g: 41, b: 55 })
  assert.deepEqual(parseColorChannels('rgb(300, -4, 12.6)'), { r: 255, g: 0, b: 13 })

  assert.equal(parseColorChannels(''), null)
  assert.equal(parseColorChannels(undefined), null)
  assert.equal(parseColorChannels('transparent'), null)
  assert.equal(parseColorChannels('rgb(1, 2)'), null)
  // No background of its own: not a colour, so not a black background either.
  assert.equal(parseColorChannels('rgba(0, 0, 0, 0)'), null)
  assert.deepEqual(parseColorChannels('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0 })

  assert.equal(toRgbString(parseColorChannels('31 41 55')), 'rgb(31, 41, 55)')
})

test('a theme is derived from the surface, or not claimed at all', () => {
  const theme = resolveTerminalTheme({
    background: 'rgb(31, 41, 55)',
    foreground: 'rgb(247, 248, 250)',
    cursor: '22 163 74',
  })
  assert.deepEqual(theme, {
    background: 'rgb(31, 41, 55)',
    foreground: 'rgb(247, 248, 250)',
    cursor: 'rgb(22, 163, 74)',
    selectionBackground: 'rgba(247, 248, 250, 0.28)',
  })

  // Without a cursor token the text colour is a better cursor than nothing.
  assert.equal(resolveTerminalTheme({
    background: 'rgb(31, 41, 55)',
    foreground: 'rgb(247, 248, 250)',
  }).cursor, 'rgb(247, 248, 250)')

  // Half a palette is worse than xterm's own defaults.
  assert.equal(resolveTerminalTheme({ foreground: 'rgb(247, 248, 250)' }), undefined)
  assert.equal(resolveTerminalTheme({ background: 'rgba(0, 0, 0, 0)', foreground: 'rgb(0, 0, 0)' }), undefined)
  assert.equal(resolveTerminalTheme(), undefined)
})

test('the theme is read from what the element actually paints', () => {
  const scope = {
    getComputedStyle: () => ({
      backgroundColor: 'rgb(24, 24, 27)',
      color: 'rgb(244, 244, 245)',
      getPropertyValue: (name) => (name === '--color-accent-rgb' ? '22 163 74' : ''),
    }),
  }
  assert.deepEqual(terminalThemeForElement({}, scope), {
    background: 'rgb(24, 24, 27)',
    foreground: 'rgb(244, 244, 245)',
    cursor: 'rgb(22, 163, 74)',
    selectionBackground: 'rgba(244, 244, 245, 0.28)',
  })

  assert.equal(terminalThemeForElement(null, scope), undefined)
  assert.equal(terminalThemeForElement({}, {}), undefined)
})

test('the terminal inherits the panel type, with a floor that keeps it readable', () => {
  const scope = (styles) => ({ getComputedStyle: () => styles })
  assert.deepEqual(
    terminalTypographyForElement({}, scope({ fontSize: '12px', fontFamily: 'ui-monospace, monospace' })),
    { fontSize: 12, fontFamily: 'ui-monospace, monospace' },
  )
  assert.equal(terminalTypographyForElement({}, scope({ fontSize: '8px' })).fontSize, 12)
  assert.equal(terminalTypographyForElement({}, scope({ fontSize: '14.5px' })).fontSize, 14.5)
  assert.deepEqual(terminalTypographyForElement({}, scope({ fontSize: '' })), {
    fontSize: 12,
    fontFamily: 'monospace',
  })
  assert.deepEqual(terminalTypographyForElement(null, {}), { fontSize: 12, fontFamily: 'monospace' })
})

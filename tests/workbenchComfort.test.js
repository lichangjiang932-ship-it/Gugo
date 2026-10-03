import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')
const styles = source('../src/index.css')
const theme = (name) => styles.match(new RegExp(`html\\[data-theme="${name}"\\]\\s*\\{([^}]+)\\}`))?.[1] || ''
const rgb = (block, name) => block.match(new RegExp(`--color-${name}-rgb:\\s*(\\d+) (\\d+) (\\d+)`))?.slice(1).map(Number)
const luminance = (channels) => channels.map((value) => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)

test('soft shell surfaces remain distinct and preserve readable text in every theme', () => {
  for (const name of ['light', 'white', 'dark']) {
    const block = theme(name)
    const paper = rgb(block, 'paper')
    const sidebar = rgb(block, 'sidebar')
    assert.ok(sidebar, name)
    assert.notDeepEqual(sidebar, paper, 'navigation has its own quiet background')
    for (const foreground of ['ink', 'ink-soft']) {
      for (const background of ['paper', 'sidebar', 'surface']) {
        const pair = [luminance(rgb(block, foreground)), luminance(rgb(block, background))].sort((a, b) => b - a)
        assert.ok((pair[0] + 0.05) / (pair[1] + 0.05) >= 4.5, `${name}: ${foreground} on ${background}`)
      }
    }
  }
})

test('dark surfaces use dark elevation instead of an inverse white glow', () => {
  assert.deepEqual(rgb(theme('dark'), 'shadow'), [0, 0, 0])
  for (const selector of ['.chat-composer-surface', '.chat-composer-surface:focus-within', '.chat-composer-primary-action']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const block = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || ''
    assert.match(block, /box-shadow:[\s\S]*var\(--color-shadow-rgb\)/)
    assert.doesNotMatch(block, /box-shadow:[\s\S]*var\(--color-ink-rgb\)/)
  }
})

test('system typography and sidebar text share a readable scale without changing saved preferences', () => {
  assert.match(styles, /--font-ui:[^;]*Segoe UI[^;]*Microsoft YaHei/)
  assert.match(styles, /font-family: var\(--font-ui\)/)
  assert.match(source('../tailwind.config.js'), /sans: \['var\(--font-ui\)'\]/)
  assert.match(source('../src/components/LeftRail.jsx'), /bg-sidebar/)
  assert.match(source('../src/components/leftRail/SessionList.jsx'), /truncate text-ui leading-5/)
  assert.match(source('../src/components/leftRail/LeftRail.css'), /min-height: 38px/)
  assert.match(source('../src/store/appStateBootstrap.js'), /theme: 'white'/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyAccent, hexToHsl } from '../../src/lib/themeAccent.js'

test('hexToHsl(#E86A3C) → ember 落在橙色 hue 区间', () => {
  const hsl = hexToHsl('#E86A3C')
  assert.ok(hsl, 'should parse')
  // 橙色 hue 大概在 15..30
  assert.ok(hsl.h >= 10 && hsl.h <= 35, `expected orange hue 10..35, got ${hsl.h}`)
  assert.ok(hsl.s >= 50 && hsl.s <= 100, `expected vivid sat, got ${hsl.s}`)
  assert.ok(hsl.l >= 30 && hsl.l <= 70, `expected mid lum, got ${hsl.l}`)
})

test('hexToHsl 接受短形式 / 大写 / 无 # 前缀', () => {
  const a = hexToHsl('#fff')
  assert.equal(a.l, 100)
  const b = hexToHsl('FFFFFF')
  assert.equal(b.l, 100)
  const c = hexToHsl('#A5C97A')
  assert.ok(c.h >= 60 && c.h <= 150, `green-ish hue, got ${c.h}`)
})

test('hexToHsl 非法值返回 null', () => {
  assert.equal(hexToHsl(''), null)
  assert.equal(hexToHsl('#zzz'), null)
  assert.equal(hexToHsl(null), null)
})

test('applyAccent({ hex: ember, strong:false }) → vars + 空 className', () => {
  const res = applyAccent({ hex: '#E86A3C', strong: false })
  assert.equal(res.className, '')
  assert.ok(res.vars['--accent-h'])
  assert.ok(res.vars['--accent-s'].endsWith('%'))
  assert.ok(res.vars['--accent-l'].endsWith('%'))
  assert.ok(res.vars['--accent'].startsWith('hsl('))
  const h = Number(res.vars['--accent-h'])
  assert.ok(h >= 10 && h <= 35)
})

test('applyAccent({ strong:true }) → className theme-accent-strong + 更深/更艳', () => {
  const base = applyAccent({ hex: '#E86A3C', strong: false })
  const strong = applyAccent({ hex: '#E86A3C', strong: true })
  assert.equal(strong.className, 'theme-accent-strong')
  // strong 模式: l 降一档,s 升一档
  const baseL = parseInt(base.vars['--accent-l'], 10)
  const strongL = parseInt(strong.vars['--accent-l'], 10)
  const baseS = parseInt(base.vars['--accent-s'], 10)
  const strongS = parseInt(strong.vars['--accent-s'], 10)
  assert.ok(strongL <= baseL, `strong L should be ≤ base L, got ${strongL} vs ${baseL}`)
  assert.ok(strongS >= baseS, `strong S should be ≥ base S, got ${strongS} vs ${baseS}`)
  assert.equal(strong.vars['--workbench-accent'], strong.vars['--accent'])
  assert.equal(strong.vars['--workbench-accent-h'], strong.vars['--accent-h'])
})

test('artifact and document surfaces use neutral tokens outside the workbench accent domain', () => {
  const css = fs.readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
  assert.match(css, /\[data-artifact-surface\]\s*\{/)
  assert.match(css, /--artifact-accent-rgb:\s*var\(--color-ink-soft-rgb\)/)
  assert.match(css, /--color-ember-rgb:\s*var\(--artifact-accent-rgb\)/)
  assert.match(css, /--accent:\s*var\(--artifact-accent\)/)
  assert.doesNotMatch(css, /\.theme-accent-strong\s+\[data-artifact-surface\]/)
  assert.doesNotMatch(css, /\.theme-accent-strong\s+\.chat-output-file-name/)
  assert.doesNotMatch(css, /(?:^|\r?\n)\s*\[data-artifact-surface\][^{}]*\{[^{}]*!important/m)
  assert.match(css, /\.theme-accent-strong a\.primary:not\(\[data-artifact-surface\]\):not\(\[data-artifact-surface\] \*\)/)
  assert.match(css, /\.theme-accent-strong button\.primary:not\(\[data-artifact-surface\]\):not\(\[data-artifact-surface\] \*\)/)
  assert.match(css, /color:\s*var\(--accent\)\s*!important/)
})

test('applyAccent({}) 缺省回退到 ember 默认色', () => {
  const res = applyAccent({})
  const h = Number(res.vars['--accent-h'])
  assert.ok(h >= 10 && h <= 35, `default ember hue, got ${h}`)
  assert.equal(res.className, '')
})

test('applyAccent 接受四个预设色,h 都落在 0..360', () => {
  const presets = ['#E86A3C', '#2E8FA3', '#A5C97A', '#D4A4FF']
  for (const hex of presets) {
    const res = applyAccent({ hex, strong: false })
    const h = Number(res.vars['--accent-h'])
    assert.ok(h >= 0 && h <= 360, `hue range for ${hex}: ${h}`)
  }
})

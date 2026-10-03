import assert from 'node:assert/strict'
import test from 'node:test'

import {
  colorEnabled,
  createStyler,
  renderInlineMarkdown,
  renderMarkdown,
  STYLE_NAMES,
  stylerForStream,
} from '../../bin/cli/terminalTheme.js'

// Built from the code point so the file holds no literal control character (and no
// eslint-disable for no-control-regex).
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[\\d+(?:;\\d+)*m`, 'gu')
const stripAnsi = (text) => String(text).replace(ANSI, '')

test('colour follows NO_COLOR, FORCE_COLOR and TTY like every other CLI', () => {
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: {} }), true)
  assert.equal(colorEnabled({ stream: { isTTY: false }, env: {} }), false)
  assert.equal(colorEnabled({ stream: {}, env: {} }), false)
  assert.equal(colorEnabled({}), false)

  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: '1' } }), false)
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: '' } }), true, 'an empty NO_COLOR is not a request')
  assert.equal(colorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: '1' } }), true)
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { FORCE_COLOR: '0' } }), false)
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: '1', FORCE_COLOR: '1' } }), false, 'NO_COLOR wins')

  assert.equal(stylerForStream({ isTTY: true }, {}).enabled, true)
  assert.equal(stylerForStream({ isTTY: false }, {}).enabled, false)
})

test('a disabled styler is the identity function, so callers never branch', () => {
  const plain = createStyler(false)
  assert.equal(plain.enabled, false)
  for (const name of STYLE_NAMES) assert.equal(plain[name]('text'), 'text', `${name} must be identity`)
  assert.equal(plain.style('text', 'bold', 'red'), 'text')
  assert.equal(plain.bold(''), '')
  assert.equal(plain.bold(null), '')
  assert.equal(plain.bold(undefined), '')
  assert.equal(plain.bold(42), '42')
})

test('an enabled styler paints without dropping any character', () => {
  const styled = createStyler(true)
  assert.equal(styled.enabled, true)
  const painted = styled.bold('hello')
  assert.notEqual(painted, 'hello')
  assert.equal(stripAnsi(painted), 'hello')
  assert.equal(stripAnsi(styled.style('x', 'bold', 'cyan')), 'x')
  assert.equal(styled.style('x', 'not-a-style'), 'x', 'unknown style names are ignored')
  assert.equal(styled.style('x'), 'x')
})

test('inline rendering consumes decorative markers and protects code spans from the bold pass', () => {
  const styled = createStyler(true)
  const source = 'Use `**a**` and **b** today'
  const rendered = renderInlineMarkdown(source, styled)
  assert.equal(rendered, `Use ${styled.cyan('**a**')} and ${styled.bold('b')} today`)
  assert.ok(rendered.includes('**a**'), 'asterisks inside a code span survive verbatim')
  assert.ok(!stripAnsi(rendered).includes('`'), 'backticks are consumed')
  assert.ok(!stripAnsi(rendered).includes('**b**'), 'bold markers are consumed')
  assert.equal(renderInlineMarkdown(source, createStyler(false)), source, 'disabled rendering is byte-identical')
  assert.equal(renderInlineMarkdown('', styled), '')
  assert.equal(renderInlineMarkdown(null, styled), '')
})

test('block rendering preserves line count, order and text', () => {
  const styled = createStyler(true)
  const source = [
    '# Title',
    '',
    'paragraph with `code`',
    '',
    '- bullet one',
    '1. numbered',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '> quoted line',
  ].join('\n')
  const rendered = renderMarkdown(source, styled)
  assert.equal(rendered.split('\n').length, source.split('\n').length, 'line count is preserved')
  assert.ok(!stripAnsi(rendered).includes('# Title'), 'the heading marker is consumed')
  assert.ok(stripAnsi(rendered).includes('Title'), 'the heading text survives')
  assert.ok(stripAnsi(rendered).includes('const a = 1'), 'code block content survives')
  assert.ok(stripAnsi(rendered).includes('- bullet one'), 'list markers stay: they carry structure')
  assert.ok(stripAnsi(rendered).includes('> quoted line'), 'quote markers stay: they carry structure')
  assert.equal(renderMarkdown(source, createStyler(false)), source, 'disabled rendering is byte-identical')
})

test('an unterminated code fence dims to the end without losing lines', () => {
  const styled = createStyler(true)
  const source = 'before\n```\ninside\nstill inside'
  const rendered = renderMarkdown(source, styled)
  assert.equal(stripAnsi(rendered), source)
  assert.equal(rendered.split('\n').length, source.split('\n').length)
})

test('plain prose and empty input pass through untouched even when colour is on', () => {
  const styled = createStyler(true)
  assert.equal(renderMarkdown('just a sentence', styled), 'just a sentence')
  assert.equal(renderInlineMarkdown('nothing to style', styled), 'nothing to style')
  assert.equal(renderMarkdown('', styled), '')
  assert.equal(renderMarkdown(null, styled), '')
})

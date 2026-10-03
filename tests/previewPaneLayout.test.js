import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_PREVIEW_PANE_WIDTH, MIN_PREVIEW_CHAT_WIDTH, MIN_PREVIEW_PANE_WIDTH,
  clampPreviewPaneWidth, normalizePreviewPanePreference, previewPaneLayout,
} from '../src/pages/ChatSplit/preview/previewPaneLayout.js'

test('split width reserves readable chat space in the main area after the rail', () => {
  for (const available of [840, 900, 1000, 1200, 1440]) {
    const layout = previewPaneLayout(900, available)
    assert.equal(layout.overlay, false)
    assert.ok(available - layout.paneWidth >= MIN_PREVIEW_CHAT_WIDTH)
    assert.ok(layout.paneWidth >= MIN_PREVIEW_PANE_WIDTH)
  }
  assert.equal(clampPreviewPaneWidth(520, 900), 420)
})

test('main areas too narrow for two usable panes focus preview without reserving a split', () => {
  for (const available of [320, 600, 800, 839]) {
    assert.equal(previewPaneLayout(520, available).focused, true)
    assert.equal(previewPaneLayout(520, available).overlay, true)
  }
  assert.equal(previewPaneLayout(520, 840).focused, false)
  assert.equal(previewPaneLayout(520, 1440, true).overlay, true)
})

test('container clamping never rewrites the independent saved width preference', () => {
  const preference = normalizePreviewPanePreference('900')
  assert.equal(previewPaneLayout(preference, 900).paneWidth, 420)
  assert.equal(previewPaneLayout(preference, 1440).paneWidth, 900)
  for (const value of [undefined, null, '', 'broken', Infinity, NaN]) {
    assert.equal(normalizePreviewPanePreference(value), DEFAULT_PREVIEW_PANE_WIDTH)
  }
  assert.equal(normalizePreviewPanePreference(50_000), 900)
})

test('verified filename decoration is scoped to the label without changing Markdown or hrefs', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  assert.match(css, /\.chat-inline-file-reference \.chat-output-file-name code::before,\s*\.chat-inline-file-reference \.chat-output-file-name code::after\s*\{\s*content: none;/)
  assert.match(css, /\.chat-inline-file-reference \.chat-output-file-name\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/)
  assert.doesNotMatch(css, /\.prose code::before,\s*\.prose code::after/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { PREVIEW_SHORTCUT, matchPreviewShortcut, previewShortcutLabel } from '../../src/lib/previewShortcuts.js'
import { shortcutLabelFor } from '../../src/lib/workbenchShortcuts.js'

function keydown(overrides = {}) {
  return {
    key: 'p',
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    ...overrides,
  }
}

test('the preview key is Ctrl+Shift+P and nothing looser', () => {
  assert.equal(matchPreviewShortcut(keydown()), true)
  assert.equal(matchPreviewShortcut(keydown({ key: 'P' })), true, 'the letter is case insensitive')
  // Each missing modifier is a different combination.
  assert.equal(matchPreviewShortcut(keydown({ shiftKey: false })), false)
  assert.equal(matchPreviewShortcut(keydown({ ctrlKey: false })), false)
  // Extra modifiers are other applications' shortcuts, not this one.
  assert.equal(matchPreviewShortcut(keydown({ altKey: true })), false)
  assert.equal(matchPreviewShortcut(keydown({ metaKey: true })), false)
  assert.equal(matchPreviewShortcut(keydown({ key: 'o' })), false)
  assert.equal(matchPreviewShortcut(null), false)
  assert.equal(matchPreviewShortcut({ key: 1, ctrlKey: true, shiftKey: true }), false)
})

test('the label names the key on this platform and matches the bound one', () => {
  assert.equal(previewShortcutLabel({ platform: 'Win32' }), 'Ctrl+Shift+P')
  assert.equal(previewShortcutLabel({ platform: 'MacIntel' }), '⌘⇧P')
  // The label comes from the same descriptor that the matcher reads, so the
  // tooltip cannot promise a combination the handler ignores.
  assert.equal(PREVIEW_SHORTCUT.ctrl && PREVIEW_SHORTCUT.shift && PREVIEW_SHORTCUT.key === 'p', true)
  assert.equal(shortcutLabelFor({ ctrl: true, alt: false, key: 't' }, { platform: 'Win32' }), 'Ctrl+T')
})

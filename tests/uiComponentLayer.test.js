import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const styles = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const tailwind = fs.readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8')
const modal = fs.readFileSync(new URL('../src/components/Modal.jsx', import.meta.url), 'utf8')

test('shared component layer exposes the canonical controls and surfaces', () => {
  assert.match(styles, /@layer components/)
  for (const className of ['btn-primary', 'btn-ghost', 'input', 'card', 'modal-base']) {
    assert.match(styles, new RegExp(`\\.${className}\\s*[,\\{]`))
  }
})

test('overlay, modal, and toast use the shared 40/50/60 layer scale', () => {
  assert.match(tailwind, /overlay:\s*'40'/)
  assert.match(tailwind, /modal:\s*'50'/)
  assert.match(tailwind, /toast:\s*'60'/)
  assert.match(styles, /\.modal-overlay[\s\S]*?z-overlay/)
  assert.match(styles, /\.modal-base[\s\S]*?z-modal/)
  assert.match(styles, /\.toast-layer[\s\S]*?z-toast/)
})

test('Modal centralizes portal, Escape, focus, and configurable backdrop behavior', () => {
  assert.match(modal, /createPortal/)
  assert.match(modal, /useModalFocusTrap/)
  assert.match(modal, /closeOnBackdrop/)
  assert.match(modal, /restoreFocusSelector/)
  assert.match(modal, /role="dialog"/)
  assert.match(modal, /aria-modal="true"/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('artifact preview iframes do not allow modal popups by default', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8')

  assert.match(source, /sandbox="allow-scripts allow-forms"/)
  assert.doesNotMatch(source, /allow-modals/)
})

test('React artifact previews apply the shared readability guard', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8')

  assert.match(source, /import \{[^}]*enhanceHtmlPreviewReadability[^}]*\} from '\.\.\/\.\.\/lib\/artifactPreview\.js'/)
  assert.match(source, /return enhanceHtmlPreviewReadability\(`<!doctype html>/)
})

test('pptx default download uses premium visual export and keeps editable fallback explicit', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8')

  assert.match(source, /await downloadPremiumPptx\(content, \{/)
  assert.match(source, /handleEditablePptxDownload/)
  assert.match(source, /_editable\.pptx/)
  assert.match(source, /downloadPptxFromMarkdown\(content, \{/)
})

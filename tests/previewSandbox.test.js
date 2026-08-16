import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from './sourceTree.js'

const previewSource = () => readSourceTree('../src/pages/ChatSplit/preview/')

test('artifact preview iframes do not allow modal popups by default', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8') + previewSource()

  assert.match(source, /sandbox="allow-scripts allow-forms"/)
  assert.doesNotMatch(source, /allow-modals/)
})

test('task HTML previews fetch source outside the sandbox and never put download tokens in iframe URLs', () => {
  const source = fs.readFileSync(new URL('../src/pages/TaskArtifactPreview.jsx', import.meta.url), 'utf8')

  assert.match(source, /loadArtifactPreviewDocument\(artifactUrl/)
  assert.match(source, /URL\.revokeObjectURL/)
  assert.match(source, /srcDoc=\{previewHtml\}/)
  assert.match(source, /sandbox="allow-scripts"/)
  assert.doesNotMatch(source, /<iframe[\s\S]*?src=\{downloadUrl\}/)
})

test('React artifact previews apply the shared readability guard', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/preview/reactSandboxDocument.js', import.meta.url), 'utf8')

  assert.match(source, /import \{[^}]*enhanceHtmlPreviewReadability[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/artifactPreview\.js'/)
  assert.match(source, /return enhanceHtmlPreviewReadability\(documentHtml, \{ nonce \}\)/)
})

test('pptx default download uses premium visual export and keeps editable fallback explicit', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8') + previewSource()

  assert.match(source, /await downloadPremiumPptx\(content, \{/)
  assert.match(source, /handleEditablePptxDownload/)
  assert.match(source, /_editable\.pptx/)
  assert.match(source, /downloadPptxFromMarkdown\(content, \{/)
})

test('presentation artifacts open in an immersive fixed-ratio canvas', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8') + previewSource()
  const styles = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

  assert.match(source, /function isPresentationArtifact/)
  assert.match(source, /useState\(\(\) => isPresentationArtifact\(artifact\)\)/)
  assert.match(source, /setMaximized\(isPresentationArtifact\(artifact\)\)/)
  assert.match(source, /maximized \? 'chat-preview-pane-maximized fixed inset-0 w-screen' : 'relative shrink-0'/)
  assert.match(source, /html-deck-stage/)
  assert.match(source, /html-deck-frame/)
  assert.match(styles, /\.html-deck-frame[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/)
})

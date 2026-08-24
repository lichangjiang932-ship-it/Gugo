import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const lineCount = (source) => source.trimEnd().split(/\r?\n/).length

const view = read('../src/pages/ChatSplit/ChatSplitView.jsx')
const rightPanels = read('../src/pages/ChatSplit/chatSplitView/ChatRightPanels.jsx')

test('chat split view and extracted right panels stay within the component size budget', () => {
  assert.ok(lineCount(view) <= 300, `ChatSplitView.jsx has ${lineCount(view)} lines`)
  assert.ok(lineCount(rightPanels) <= 300, `ChatRightPanels.jsx has ${lineCount(rightPanels)} lines`)
})

test('chat split view delegates the mutually exclusive right panel without changing its API', () => {
  assert.match(view, /import ChatRightPanels from '\.\/chatSplitView\/ChatRightPanels\.jsx'/)
  assert.match(view, /export \{ ChatRightPanels \}/)
  assert.match(view, /<ChatRightPanels/)
  assert.doesNotMatch(view, /import RightPreviewPane|import RightWorkbench/)
  assert.match(rightPanels, /if \(!workbenchOpen\) return null/)
  assert.match(rightPanels, /if \(previewArtifact\)/)
  assert.match(rightPanels, /<RightPreviewPane/)
  assert.match(rightPanels, /<RightWorkbench/)
})

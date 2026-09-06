import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const lineCount = (source) => source.trimEnd().split(/\r?\n/).length

const view = read('../src/pages/ChatSplit/ChatSplitView.jsx')
const rightPanels = read('../src/pages/ChatSplit/chatSplitView/ChatRightPanels.jsx')
const sessionHeader = read('../src/pages/ChatSplit/chatSplitView/ChatSessionHeader.jsx')

test('chat split view and extracted right panels stay within the component size budget', () => {
  assert.ok(lineCount(view) <= 300, `ChatSplitView.jsx has ${lineCount(view)} lines`)
  assert.ok(lineCount(rightPanels) <= 300, `ChatRightPanels.jsx has ${lineCount(rightPanels)} lines`)
  assert.ok(lineCount(sessionHeader) <= 100, `ChatSessionHeader.jsx has ${lineCount(sessionHeader)} lines`)
})

test('chat split view delegates header presentation while keeping its controls and selectors', () => {
  assert.match(view, /import \{ ChatSessionHeading, ChatWorkbenchToggle \} from '\.\/chatSplitView\/ChatSessionHeader\.jsx'/)
  assert.match(view, /<ChatSessionHeading hasWorkspace=\{hasWorkspace\}/)
  assert.match(view, /data-testid="chat-session-title"/)
  assert.match(view, /<ChatWorkbenchToggle[\s\S]*?open=\{workbenchOpen\}/)
  assert.match(view, /onClick=\{onWorkbenchToggle\}/)
  assert.match(view, /aria-controls="right-workbench"/)
  assert.match(view, /aria-expanded=\{workbenchOpen\}/)
  assert.match(sessionHeader, /<h1[\s\S]*?\{\.\.\.headingAttributes\}/)
  assert.match(sessionHeader, /<button[\s\S]*?\{\.\.\.buttonAttributes\}/)
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

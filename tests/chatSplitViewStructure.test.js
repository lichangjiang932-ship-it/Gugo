import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const lineCount = (source) => source.trimEnd().split(/\r?\n/).length

const view = read('../src/pages/ChatSplit/ChatSplitView.jsx')
const rightPanels = read('../src/pages/ChatSplit/chatSplitView/ChatRightPanels.jsx')
const sessionHeader = read('../src/pages/ChatSplit/chatSplitView/ChatSessionHeader.jsx')
// The header bar owns the controls the reader sees; ChatSessionHeader.jsx owns
// the two shared shapes they are built from.
const headerBar = read('../src/pages/ChatSplit/chatSplitView/ChatSessionHeaderBar.jsx')

test('chat split view and extracted right panels stay within the component size budget', () => {
  assert.ok(lineCount(view) <= 300, `ChatSplitView.jsx has ${lineCount(view)} lines`)
  assert.ok(lineCount(rightPanels) <= 300, `ChatRightPanels.jsx has ${lineCount(rightPanels)} lines`)
  assert.ok(lineCount(sessionHeader) <= 100, `ChatSessionHeader.jsx has ${lineCount(sessionHeader)} lines`)
})

test('the header opens the checklist instead of the branch navigator', () => {
  assert.match(headerBar, /data-testid="header-plan-toggle"/)
  assert.match(headerBar, /aria-pressed=\{planVisible \|\| undefined\}/)
  assert.doesNotMatch(headerBar, /SessionBranchNavigator/)
  // The view mounts that bar and nothing else of its presentation.
  assert.match(view, /<ChatSessionHeaderBar/)
  assert.doesNotMatch(view, /SessionBranchNavigator/)
})

test('chat split view delegates header presentation while keeping its controls and selectors', () => {
  assert.match(view, /import ChatSessionHeaderBar from '\.\/chatSplitView\/ChatSessionHeaderBar\.jsx'/)
  assert.match(headerBar, /import \{ ChatPreviewButton, ChatSessionHeading, ChatWorkbenchToggle \} from '\.\/ChatSessionHeader\.jsx'/)
  assert.match(headerBar, /<ChatSessionHeading hasWorkspace=\{hasWorkspace\}/)
  assert.match(headerBar, /data-testid="chat-session-title"/)
  assert.match(headerBar, /<ChatWorkbenchToggle[\s\S]*?open=\{workbenchOpen\}/)
  assert.match(headerBar, /onClick=\{onWorkbenchToggle\}/)
  assert.match(headerBar, /aria-controls="right-workbench"/)
  assert.match(headerBar, /aria-expanded=\{workbenchOpen\}/)
  assert.match(sessionHeader, /<h1[\s\S]*?\{\.\.\.headingAttributes\}/)
  assert.match(sessionHeader, /<button[\s\S]*?\{\.\.\.buttonAttributes\}/)
})

test('chat split view delegates the right region without changing its API', () => {
  assert.match(view, /import ChatRightPanels from '\.\/chatSplitView\/ChatRightPanels\.jsx'/)
  assert.match(view, /export \{ ChatRightPanels \}/)
  assert.match(view, /<ChatRightPanels/)
  assert.doesNotMatch(view, /import RightPreviewPane|import RightWorkbench/)
  // The region closes as one thing, but the panes inside it are placed rather
  // than arbitrated: the workbench, the task list and the open file each take a
  // slot. They used to be the two branches of one ternary — opening a file took
  // the panel away from the tool that was on screen — which is what this file
  // pinned before the reader asked for all three at once.
  assert.match(rightPanels, /if \(!workbenchOpen\) return null/)
  assert.match(rightPanels, /<RightPaneGrid/)
  assert.match(rightPanels, /top=\{/)
  assert.match(rightPanels, /bottomLeft=\{planVisible \?/)
  assert.match(rightPanels, /bottomRight=\{previewArtifact \?/)
  assert.match(rightPanels, /<RightPreviewPane/)
  assert.match(rightPanels, /<RightWorkbench/)
})

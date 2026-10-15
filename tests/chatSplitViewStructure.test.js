import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

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

// Behavior lives in unit/ChatHeaderContract.test.jsx. Keep only actual ownership constraints here.
const imports = text => ts.createSourceFile('view.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX).statements
  .filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text)
test('header presentation stays owned by the header bar rather than duplicated in the view', () => {
  assert.ok(imports(view).includes('./chatSplitView/ChatSessionHeaderBar.jsx'))
  assert.ok(imports(headerBar).includes('./ChatSessionHeader.jsx'))
  assert.ok(!imports(view).some(name => name.includes('SessionBranchNavigator')))
})

test('chat split view delegates the right region without changing its API', () => {
  assert.match(view, /import ChatRightPanels from '\.\/chatSplitView\/ChatRightPanels\.jsx'/)
  assert.match(view, /export \{ ChatRightPanels \}/)
  assert.match(view, /<ChatRightPanels/)
  assert.doesNotMatch(view, /import RightPreviewPane|import RightWorkbench/)
  // The panes inside the region are placed rather than arbitrated: the
  // workbench, the task list and the open file each take a slot, and each
  // answers for whether it wants the room. They used to be the two branches of
  // one ternary behind a single `workbenchOpen` gate — opening a file switched
  // the tool panel on to carry it and took the panel away from the tool that was
  // on screen — which is what this file pinned before the reader asked for all
  // three at once.
  assert.doesNotMatch(rightPanels, /if \(!workbenchOpen\) return null/)
  assert.match(rightPanels, /<RightPaneGrid/)
  // Inside the tool panel the tab is the two levels: the entry list is the front
  // door, a tool is the room behind it. Choosing a tool closes the list and Back
  // brings it back — the list is not suppressed for anything else the reader has
  // open, which is what made Back look like it had closed the panel.
  assert.match(rightPanels, /const showWorkbench = workbenchOpen/)
  assert.match(rightPanels, /top=\{showWorkbench \?/)
  // The panes below are a list rather than a fixed pair: the change review and
  // an open file each put one in, and the row divides what is there instead of
  // reserving two places and leaving one empty. The task list is not one of
  // them — it floats over the conversation, in the view itself.
  assert.match(rightPanels, /bottoms=\{\[/)
  assert.match(rightPanels, /dockState\.panel === 'diff' \? \{/)
  assert.match(rightPanels, /previewArtifact \? \{/)
  assert.match(rightPanels, /<RightPreviewPane/)
  assert.match(view, /<PlanCard/)
  assert.doesNotMatch(rightPanels, /<PlanCard/)
  assert.match(rightPanels, /<RightWorkbench/)
})

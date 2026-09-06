import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')

test('approval and resume notices fit the actual chat pane rather than subtracting a desktop sidebar', () => {
  const view = source('../src/pages/ChatSplit/ChatSplitView.jsx')
  assert.doesNotMatch(view, /calc\(100vw-320px\)/)
  const notices = [...view.matchAll(/className="(chat-notice-dock[^"]+)"/g)]
  assert.equal(notices.length, 2)
  for (const [, classes] of notices) {
    assert.match(classes, /w-full min-w-0 max-w-\[780px\]/)
  }
  assert.match(view, /data-testid="chat-resume-dock"[\s\S]*?flex flex-wrap items-center/)
})

test('chat header distinguishes ordinary conversations from a selected project', () => {
  const view = source('../src/pages/ChatSplit/ChatSplitView.jsx')
  const header = source('../src/pages/ChatSplit/chatSplitView/ChatSessionHeader.jsx')
  assert.match(view, /const hasWorkspace = Boolean\(selectedWorkspacePath \|\| activeSession\?\.workspacePath\)/)
  assert.match(view, /data-chat-context=\{hasWorkspace \? 'project' : 'conversation'\}/)
  assert.match(view, /<ChatSessionHeading hasWorkspace=\{hasWorkspace\}/)
  assert.match(header, /hasWorkspace\s*\? <Folder[\s\S]*?: <MessageSquare/)
  assert.match(header, /title=\{title\}/)
})

test('composer actions have quiet hover feedback, accessible touch targets and reduced motion', () => {
  const actions = source('../src/pages/ChatSplit/chatComposer/ComposerActions.jsx')
  const styles = source('../src/index.css')
  assert.doesNotMatch(actions, /hover:bg-ink-ghost/)
  assert.equal((actions.match(/chat-composer-action-button inline-flex h-8 w-8/g) || []).length, 2)
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.chat-composer-action-button[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chat-composer-surface[\s\S]*?transition: none;/)
})

test('narrow composer actions wrap as groups without shrinking primary controls or clipping popovers', () => {
  const actions = source('../src/pages/ChatSplit/chatComposer/ComposerActions.jsx')
  const picker = source('../src/pages/ChatSplit/ModelPicker.jsx')
  const permission = source('../src/components/PermissionModeSwitcher.jsx')
  const pickerPanel = source('../src/pages/ChatSplit/modelPicker/ModelPickerPanel.jsx')
  assert.match(actions, /data-testid="chat-composer-actions" className="[^"]*flex flex-wrap/)
  assert.match(actions, /chat-composer-primary-action flex h-8 w-8 shrink-0/)
  assert.match(actions, /relative shrink-0/)
  assert.match(actions, /fixed bottom-24 right-3[^\n]+lg:absolute[^\n]+data-testid="context-usage-popover"/)
  assert.match(permission, /data-testid="permission-mode-popover"[^\n]+fixed bottom-24 left-3 right-3[^\n]+lg:absolute/)
  assert.match(picker, /ref=\{pickerRef\} className="relative flex min-w-0 max-w-full/)
  for (const surface of [actions, pickerPanel]) {
    assert.match(surface, /max-w-\[calc\(100%-1\.5rem\)\]/)
    assert.match(surface, /lg:max-w-none/)
  }
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { readWorkbenchOpen, writeWorkbenchOpen } from '../src/lib/chatUiPreferences.js'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('directory authorization is rendered inline above the composer', () => {
  const chat = read('../src/pages/ChatSplit/ChatSplitView.jsx')
  const approval = read('../src/components/DirectoryApprovalModal.jsx')

  assert.match(approval, /data-testid="directory-approval-card"/)
  assert.doesNotMatch(approval, /fixed inset-0|backdrop-blur/)
  assert.ok(chat.indexOf('{directoryApproval.open && (') < chat.indexOf('<ChatComposer'))
  assert.doesNotMatch(chat, /ApplyPatchApprovalModal/)
})

test('local paths are authorized before the model call and receive a tool-use instruction', () => {
  const chat = read('../src/pages/ChatSplit/index.jsx')
  const serverTurn = read('../src/pages/ChatSplit/serverTurnFlow.js')
  const preflight = chat.indexOf('await ensureLocalPathAccess(content)')
  const serverCall = chat.indexOf('await runServerChatTurn({', preflight)

  assert.ok(preflight > 0)
  assert.ok(serverCall > preflight)
  assert.match(serverTurn, /buildLocalPathToolInstruction\(localPathAccess\.paths, localPathAccess\.accessMode\)/)
  assert.match(chat, /directoryRequestCancelled/)
  assert.match(serverTurn, /await probeLocalPathAccess\(localPathAccess\)/)
  assert.ok(serverTurn.indexOf('await probeLocalPathAccess(localPathAccess)') < serverTurn.indexOf('await runServerTurn({'))
})

test('right workbench toggle leaves the navigation rail mounted', () => {
  const chat = read('../src/pages/ChatSplit/index.jsx')
  const view = read('../src/pages/ChatSplit/ChatSplitView.jsx')

  assert.match(chat, /const \[workbenchOpen, setWorkbenchOpen\] = useState\(readWorkbenchOpen\)/)
  assert.match(view, /<LeftRail \/>/)
  assert.doesNotMatch(view, /\{workbenchOpen && <LeftRail \/>\}/)
  assert.match(view, /data-testid="workbench-toggle"/)
  assert.match(view, /aria-controls="right-workbench"/)
  assert.match(view, /aria-expanded=\{workbenchOpen\}/)
  assert.match(view, /<RightWorkbench/)
  assert.match(chat, /writeWorkbenchOpen\(workbenchOpen\)/)
})

test('right workbench exposes files, side chat, browser, and terminal tools', () => {
  const workbench = read('../src/pages/ChatSplit/RightWorkbench.jsx')

  assert.match(workbench, /files: Files/)
  assert.match(workbench, /chat: MessageSquare/)
  assert.match(workbench, /browser: Globe2/)
  assert.match(workbench, /terminal: TerminalSquare/)
  assert.match(workbench, /buildArtifactPreview/)
  assert.match(workbench, /runWorkbenchTerminal/)
  assert.match(workbench, /sandbox="allow-scripts allow-forms allow-popups"/)
  assert.match(workbench, /data-testid="workbench-navigation"/)
  assert.match(workbench, /className="flex shrink-0 flex-col/)
  assert.match(workbench, /data-testid="workbench-file-count"/)
  assert.match(workbench, /message\?\.meta\?\.artifactSource \|\| message\?\.content/)
})

test('assistant metadata keeps model and latency details without account balance UI', () => {
  const messages = read('../src/pages/ChatSplit/ChatMessages.jsx')

  assert.match(messages, /data-testid="assistant-message-meta"/)
  assert.match(messages, /chatMessages\.model/)
  assert.match(messages, /chatMessages\.latency/)
  assert.doesNotMatch(messages, /creditsCharged|creditsBalance|billingError/)
  assert.match(messages, /group-focus-within\/message:opacity-100/)
})

test('typing slash opens an inline command menu above the composer', () => {
  const composer = read('../src/pages/ChatSplit/ChatComposer.jsx')
  const menu = read('../src/pages/ChatSplit/SlashCommandMenu.jsx')
  const chat = read('../src/pages/ChatSplit/index.jsx')

  assert.match(composer, /data-testid="slash-command-menu"|<SlashCommandMenu/)
  assert.match(composer, /resolveSlashMenuKey\(e\.key/)
  assert.match(menu, /bottom-\[calc\(100%\+10px\)\]/)
  assert.match(menu, /role="listbox"/)
  assert.match(chat, /slashRegistry\.listCommands\(\{ query: slashQuery \}\)/)
})

test('workbench preference defaults to closed and round-trips', () => {
  const originalWindow = globalThis.window
  const values = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  }

  try {
    assert.equal(readWorkbenchOpen(), false)
    writeWorkbenchOpen(true)
    assert.equal(readWorkbenchOpen(), true)
    writeWorkbenchOpen(false)
    assert.equal(readWorkbenchOpen(), false)
  } finally {
    globalThis.window = originalWindow
  }
})

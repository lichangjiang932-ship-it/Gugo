import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from './sourceTree.js'

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

test('local paths are authorized before the model call and paused turns resume inline', () => {
  const chat = read('../src/pages/ChatSplit/useChatSendFlow.js')
  const chatPage = read('../src/pages/ChatSplit/index.jsx')
  const directoryApproval = read('../src/pages/ChatSplit/useDirectoryApproval.js')
  const serverTurn = read('../src/pages/ChatSplit/serverTurnFlow.js')
  const resume = read('../src/pages/ChatSplit/useServerTurnResume.js')
  const pausedResume = read('../src/pages/ChatSplit/pausedTurnResume.js')
  const messageRow = read('../src/pages/ChatSplit/chatMessages/MessageRow.jsx')
  const preflight = chat.indexOf('await ensureLocalPathAccess(content)')
  const serverCall = chat.indexOf('await runServerChatTurn({', preflight)

  assert.ok(preflight > 0)
  assert.ok(serverCall > preflight)
  assert.match(chatPage, /authorizeChatDirectoryRequest\(\{/)
  assert.match(chatPage, /buildServerTurnResumeMeta\(result\.resolution\)/)
  assert.match(chatPage, /showPendingDirectoryGuidance\(typedContent\)/)
  assert.match(pausedResume, /resolvePendingDirectorySend/)
  assert.match(resume, /resumeResolution = message\.meta\?\.serverResumeResolution \|\| null/)
  assert.match(resume, /resumeResolution,/)
  assert.match(chatPage, /stateTurnRunActive: isGenerating/)
  assert.match(resume, /stateTurnRunActive/)
  assert.match(messageRow, /serverClarification\?\.request_type \|\| serverClarification\?\.requestType/)
  assert.match(messageRow, /<DirectoryRequestCard/)
  assert.match(serverTurn, /buildLocalPathToolInstruction\([\s\S]{0,160}localPathAccess\.paths,[\s\S]{0,160}localPathAccess\.accessMode,[\s\S]{0,160}localPathAccess\.resources,[\s\S]{0,80}\)/)
  assert.match(directoryApproval, /directoryApprovalResolveRef\.current\?\.\(\{ approved: false \}\)/)
  assert.match(chat, /if \(!localPathAccess\.proceed\) return/)
  assert.match(serverTurn, /await collectLocalPathEvidence\(\{/)
  assert.match(serverTurn, /signal: controller\.signal/)
  assert.ok(serverTurn.indexOf('await collectLocalPathEvidence({') < serverTurn.indexOf('await runServerTurn({'))
})

test('right workbench toggle leaves the navigation rail mounted', () => {
  const chat = readSourceTree('../src/pages/ChatSplit/')
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
  assert.match(workbench, /resolveDeliveryArtifacts/)
  assert.doesNotMatch(workbench, /buildMessageArtifactPreview/)
  assert.match(workbench, /runWorkbenchTerminal/)
  assert.match(workbench, /sandbox="allow-scripts allow-forms allow-popups"/)
  assert.match(workbench, /data-testid="workbench-navigation"/)
  assert.match(workbench, /className="flex h-10/)
  assert.match(workbench, /data-testid="workbench-file-count"/)
  assert.match(workbench, /data-testid="workbench-resize-handle"/)
  assert.match(workbench, /WIDTH_STORAGE_KEY/)
  assert.match(workbench, /const deliveryArtifacts = resolveDeliveryArtifacts\(message\?\.meta\)/)
  assert.doesNotMatch(workbench, /artifactSource \|\| message\?\.content/)
})

test('assistant metadata keeps model and latency details without account balance UI', () => {
  const messages = readSourceTree('../src/pages/ChatSplit/chatMessages/')

  assert.match(messages, /data-testid="assistant-message-meta"/)
  assert.match(messages, /chatMessages\.model/)
  assert.match(messages, /chatMessages\.latency/)
  assert.doesNotMatch(messages, /creditsCharged|creditsBalance|billingError/)
  assert.match(messages, /group-focus-within\/message:opacity-100/)
})

test('typing slash opens an inline command menu above the composer', () => {
  const composer = readSourceTree('../src/pages/ChatSplit/chatComposer/') + read('../src/pages/ChatSplit/ChatComposer.jsx')
  const menu = read('../src/pages/ChatSplit/SlashCommandMenu.jsx')
  const chat = readSourceTree('../src/pages/ChatSplit/')

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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('connection inbox stays hidden when no contact needs confirmation', () => {
  const source = read('../src/pages/AccessView.jsx')
  assert.match(source, /!loading && parkedMessages\.length > 0/)
  assert.match(source, /inboundInboxTitle:|BridgeInboundInbox/)
})

test('settings feature hub no longer exposes the low-value channels entry', () => {
  const source = read('../src/pages/SettingsView.jsx')
  const featureHub = source.slice(source.indexOf('function renderFeatureHub'), source.indexOf('const renderActive'))
  assert.doesNotMatch(featureHub, /\/channels/)
})

test('history opens on conversations and keeps session rows free of task failure status', () => {
  const source = read('../src/pages/HistoryView.jsx')
  assert.match(source, /useState\('sessions'\)/)
  assert.match(source, /\[item\.name, item\.skill, item\.status, item\.detail\]/)
  assert.match(source, /sort\(\(a, b\) => timestampValue\(b\) - timestampValue\(a\)\)/)
  assert.match(source, /getItemType\(item\) === 'tasks' &&/)
  assert.doesNotMatch(source, /a quiet log/)
})

test('chat output defaults to a compact layout with optional context usage', () => {
  const messages = read('../src/pages/ChatSplit/ChatMessages.jsx')
  const composer = read('../src/pages/ChatSplit/ChatComposer.jsx')
  const preferences = read('../src/lib/chatUiPreferences.js')
  const tools = read('../src/components/ToolCallCard.jsx')
  const styles = read('../src/index.css')
  assert.match(messages, /chat-conversation-column/)
  assert.match(messages, /max-w-\[840px\]/)
  assert.match(messages, /const isCurrentStreamingMessage = msg\.id === generatingMessageId \|\| !!msg\.meta\?\.streaming/)
  assert.doesNotMatch(messages, /<span className="uppercase tracking-\[0\.14em\]">Gugo<\/span>/)
  const contextBar = messages.match(/className="chat-context-bar[^"]+"/)?.[0] || ''
  assert.doesNotMatch(contextBar, /sticky|backdrop-blur/)
  assert.match(composer, /chat-composer/)
  assert.match(composer, /max-w-\[840px\]/)
  assert.match(tools, /className="my-1 /)
  assert.match(preferences, /readBoolean\(CONTEXT_USAGE_STORAGE_KEY, false\)/)
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.chat-message-actions/)
})

test('chat chrome stays focused on conversations and essential composer controls', () => {
  const rail = read('../src/components/LeftRail.jsx')
  const chat = read('../src/pages/ChatSplit/index.jsx')
  const chatView = read('../src/pages/ChatSplit/ChatSplitView.jsx')
  const messages = read('../src/pages/ChatSplit/ChatMessages.jsx')
  const composer = read('../src/pages/ChatSplit/ChatComposer.jsx')

  assert.match(rail, /renderSessions\(sessions\)/)
  assert.match(rail, /accountMenuOpen/)
  assert.match(rail, /path: '\/access'/)
  assert.match(rail, /path: '\/settings'/)
  assert.doesNotMatch(rail, /groupSessionsByDay|formatSessionGroupDate|formatMessageTime/)
  assert.match(rail, /dispatch\(\{ type: 'START_NEW_DRAFT' \}\)/)
  assert.doesNotMatch(rail, /handleNewChat[\s\S]*?dispatch\(\{ type: 'NEW_SESSION'/)
  const sessionRowBeforeMenu = rail.slice(
    rail.indexOf('<div key={s.id ?? i}'),
    rail.indexOf('{openMenuId === s.id &&'),
  )
  const sessionMenu = rail.match(/\{openMenuId === s\.id && \([\s\S]*?<\/div>\s*\)\}/)?.[0] || ''
  assert.doesNotMatch(sessionRowBeforeMenu, /DELETE_SESSION|<X className=/)
  assert.match(sessionMenu, /DELETE_SESSION/)
  assert.match(sessionMenu, /<X className=/)
  assert.match(sessionMenu, /setOpenMenuId\(null\)/)

  assert.doesNotMatch(`${chat}\n${chatView}`, /<ChatHeader|<TodoTracker|<CodingWorkbench/)
  assert.doesNotMatch(chat, /if \(!state\.activeSessionId\) \{\s*dispatch\(\{ type: 'NEW_SESSION'/)
  assert.match(chat, /if \(!activeSession\) \{[\s\S]*?type: 'NEW_SESSION'/)
  assert.match(chat, /const handleSend[\s\S]*?if \(!typedContent && attachments\.length === 0\) return/)
  assert.doesNotMatch(messages, /EXAMPLE_QUESTIONS|chatMessages\.emptyTitle/)
  assert.match(composer, /<PermissionModeSwitcher/)
  assert.match(composer, /<ModelPicker/)
  assert.match(composer, /<Paperclip/)
  assert.match(composer, /<Mic/)
  assert.match(composer, /<Send/)
  assert.doesNotMatch(composer, /QUICK_SKILLS|SlashAutocomplete|local-files-chat-action|onContextClick/)
})

test('chat supporting panels preserve a readable transcript on narrow screens', () => {
  const preview = read('../src/pages/ChatSplit/RightPreviewPane.jsx')
  const styles = read('../src/index.css')

  assert.match(preview, /chat-preview-pane/)
  assert.match(preview, /chat-preview-toolbar-actions/)
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?\.chat-preview-pane[\s\S]*?position: fixed;[\s\S]*?width: 100vw !important;/)
  assert.match(styles, /\.chat-preview-toolbar,\s*\.chat-preview-toolbar-actions\s*\{\s*flex-wrap: wrap;/)
})

test('skills open details before use and appearance offers a broader accent palette', () => {
  const skills = read('../src/pages/SkillsMarket.jsx')
  const settings = read('../src/components/settings/SettingsSecondaryPanels.jsx')

  assert.match(skills, /const \[selectedSkill, setSelectedSkill\] = useState\(null\)/)
  assert.match(skills, /role="dialog"/)
  assert.match(skills, /handleUseSkill\(selectedSkill\)/)
  assert.match(skills, /setSelectedSkill\(skill\)/)

  const palette = settings.match(/const ACCENT_COLORS = \[([^\]]+)\]/)?.[1] || ''
  assert.ok((palette.match(/#[0-9A-Fa-f]{6}/g) || []).length >= 8)
  assert.match(settings, /flex flex-wrap gap-3/)
})

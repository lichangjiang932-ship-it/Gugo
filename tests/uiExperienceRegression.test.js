import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('connection inbox stays hidden when no contact needs confirmation', () => {
  const source = read('../src/pages/AccessView.jsx')
  assert.match(source, /!controller\.loading && controller\.parkedMessages\.length > 0/)
  assert.match(source, /inboundInboxTitle:|BridgeInboundInbox/)
})

test('settings removes feature shortcuts without removing their standalone routes', () => {
  const settings = read('../src/pages/SettingsView.jsx')
  const panels = read('../src/components/settings/SettingsSecondaryPanels.jsx')
  const app = read('../src/App.jsx')
  assert.doesNotMatch(`${settings}\n${panels}`, /SettingsFeatureHub|\/task'|\/approvals'|\/memory'|\/desk'/)
  for (const route of ['/task', '/approvals', '/memory', '/desk']) {
    assert.match(app, new RegExp(`path="${route}"`))
  }
})

test('settings uses a grouped modal and keeps configuration modules distinct', () => {
  const settings = read('../src/pages/SettingsView.jsx')
  const navigation = read('../src/lib/settingsNavigation.js')
  const expectedSections = [
    'GENERAL',
    'MODELS',
    'APPEARANCE',
    'LANGUAGE',
    'PLUGINS',
    'WEB_SEARCH',
    'PERMISSIONS',
    'AGENT_PRESETS',
    'INTEGRATIONS',
    'DATA',
    'ABOUT',
  ]
  const navGroups = settings.match(/const SETTINGS_NAV_GROUPS = \[([\s\S]*?)\n\]/)?.[1] || ''
  const actualSections = [...navGroups.matchAll(/SETTINGS_TAB_([A-Z_]+)/g)].map((match) => match[1])
  assert.deepEqual(actualSections, expectedSections)
  const panelMappings = {
    GENERAL: /case SETTINGS_TAB_GENERAL:\s*return renderGeneral\(\)/,
    MODELS: /case SETTINGS_TAB_MODELS:\s*return renderModels\(\)/,
    APPEARANCE: /case SETTINGS_TAB_APPEARANCE:\s*return <SettingsAppearancePanel/,
    LANGUAGE: /case SETTINGS_TAB_LANGUAGE:\s*return renderLanguage\(\)/,
    PLUGINS: /case SETTINGS_TAB_PLUGINS:\s*return <SettingsPluginsPanel/,
    WEB_SEARCH: /case SETTINGS_TAB_WEB_SEARCH:\s*return <SettingsWebSearchPanel/,
    PERMISSIONS: /case SETTINGS_TAB_PERMISSIONS:\s*return <SettingsPermissionsPanel/,
    AGENT_PRESETS: /case SETTINGS_TAB_AGENT_PRESETS:\s*return <SettingsAgentPresetsPanel/,
    INTEGRATIONS: /case SETTINGS_TAB_INTEGRATIONS:\s*return <SettingsIntegrationsPanel/,
    DATA: /case SETTINGS_TAB_DATA:\s*return <SettingsDataExport/,
    ABOUT: /case SETTINGS_TAB_ABOUT:\s*default:\s*return renderAbout\(\)/,
  }
  for (const section of expectedSections) {
    assert.match(settings, panelMappings[section], `${section} must render its own panel`)
  }
  assert.match(settings, /className="settings-page-backdrop"/)
  assert.match(settings, /role="dialog"/)
  assert.match(settings, /aria-modal="true"/)
  assert.match(settings, /inert=\{true\}/)
  assert.match(settings, /useModalFocusTrap/)
  assert.match(settings, /settings\.openConfigFile/)
  assert.match(settings, /openRuntimeConfigInBrowser/)
  assert.doesNotMatch(settings, /configFileWebFallback/)
  assert.doesNotMatch(settings, /SETTINGS_NAV_ITEMS|SETTINGS_TAB_FEATURES|SETTINGS_TAB_FILES|SETTINGS_TAB_PET/)
  assert.doesNotMatch(settings, /SettingsToolsPanel|SETTINGS_TAB_TOOLS/)
  assert.match(navigation, /settingsPathForSection/)
})

test('history opens on conversations and keeps session rows free of task failure status', () => {
  const source = read('../src/pages/HistoryView.jsx')
  const content = read('../src/pages/history/HistoryContent.jsx')
  assert.match(source, /useState\('sessions'\)/)
  assert.match(source, /\[item\.name, item\.skill, item\.status, item\.detail\]/)
  assert.match(source, /sort\(\(a, b\) => timestampValue\(b\) - timestampValue\(a\)\)/)
  assert.match(content, /getItemType\(item\) === 'tasks' &&/)
  assert.doesNotMatch(source, /a quiet log/)
})

test('chat output defaults to a compact layout with optional context usage', () => {
  const messages = read('../src/pages/ChatSplit/ChatMessages.jsx')
  const messageRow = read('../src/pages/ChatSplit/chatMessages/MessageRow.jsx')
  const contextUsage = read('../src/pages/ChatSplit/chatMessages/ContextUsagePanel.jsx')
  const composer = read('../src/pages/ChatSplit/ChatComposer.jsx')
  const preferences = read('../src/lib/chatUiPreferences.js')
  const tools = read('../src/components/ToolCallCard.jsx')
  const styles = read('../src/index.css')
  assert.match(messages, /chat-conversation-column/)
  assert.match(messages, /max-w-\[840px\]/)
  assert.match(messageRow, /const isCurrentStreamingMessage = msg\.meta\?\.streaming === true[\s\S]*?msg\.meta\?\.streaming == null && msg\.id === generatingMessageId/)
  assert.doesNotMatch(messages, /<span className="uppercase tracking-\[0\.14em\]">Gugo<\/span>/)
  const contextBar = contextUsage.match(/className="chat-context-bar[^"]+"/)?.[0] || ''
  assert.doesNotMatch(contextBar, /sticky|backdrop-blur/)
  assert.match(composer, /chat-composer/)
  assert.match(composer, /max-w-\[840px\]/)
  assert.match(tools, /className="chat-tool-step"/)
  assert.match(tools, /className="chat-tool-details-card"/)
  assert.match(tools, /data-testid="tool-step-details"/)
  assert.match(styles, /\.chat-output-file-name code[\s\S]*?color: inherit !important;/)
  assert.match(preferences, /readBoolean\(CONTEXT_USAGE_STORAGE_KEY, false\)/)
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.chat-message-actions/)
})

test('chat chrome stays focused on conversations and essential composer controls', () => {
  const rail = read('../src/components/LeftRail.jsx')
  const sessions = read('../src/components/leftRail/SessionList.jsx')
  const account = read('../src/components/leftRail/AccountArea.jsx')
  const chat = read('../src/pages/ChatSplit/index.jsx')
  const sendFlow = read('../src/pages/ChatSplit/useChatSendFlow.js')
  const chatView = read('../src/pages/ChatSplit/ChatSplitView.jsx')
  const messages = read('../src/pages/ChatSplit/ChatMessages.jsx')
  const welcome = read('../src/pages/ChatSplit/chatMessages/NewConversationWelcome.jsx')
  const composer = read('../src/pages/ChatSplit/ChatComposer.jsx')
  const composerActions = read('../src/pages/ChatSplit/chatComposer/ComposerActions.jsx')

  assert.match(rail, /<SessionList/)
  assert.match(rail, /onSearch=\{handleSearch\}/)
  assert.match(rail, /collapsed && navButton\(Search/)
  assert.doesNotMatch(rail, /navButton\(Wrench|path: '\/skills'/)
  assert.match(sessions, /aria-label=\{t\('nav\.searchPlaceholder'\)\}/)
  assert.match(account, /accountMenuOpen/)
  assert.match(account, /path: '\/access'/)
  assert.match(account, /path: '\/settings'/)
  assert.doesNotMatch(rail, /groupSessionsByDay|formatSessionGroupDate|formatMessageTime/)
  assert.match(rail, /dispatch\(\{ type: 'START_NEW_DRAFT' \}\)/)
  assert.doesNotMatch(rail, /handleNewChat[\s\S]*?dispatch\(\{ type: 'NEW_SESSION'/)
  const sessionMenuStart = sessions.indexOf('{isMenuOpen && <div')
  assert.notEqual(sessionMenuStart, -1)
  const sessionRowBeforeMenu = sessions.slice(
    sessions.indexOf('return <div'),
    sessionMenuStart,
  )
  const sessionMenu = sessions.slice(sessionMenuStart)
  assert.doesNotMatch(sessionRowBeforeMenu, /DELETE_SESSION|<X className=/)
  assert.match(sessionMenu, /onDelete\(session\)/)
  assert.match(sessionMenu, /<X className=/)

  assert.doesNotMatch(`${chat}\n${chatView}`, /<ChatHeader|<TodoTracker|<CodingWorkbench/)
  assert.doesNotMatch(chat, /if \(!state\.activeSessionId\) \{\s*dispatch\(\{ type: 'NEW_SESSION'/)
  assert.match(sendFlow, /if \(!activeSession\) \{[\s\S]*?type: 'NEW_SESSION'/)
  assert.match(chat, /const handleSend[\s\S]*?if \(!typedContent && attachments\.length === 0\) return/)
  assert.doesNotMatch(messages, /EXAMPLE_QUESTIONS/)
  assert.match(welcome, /data-testid="new-conversation-welcome"/)
  assert.match(welcome, /chatMessages\.emptyTitle/)
  assert.match(welcome, /STARTER_PROMPTS\.map/)
  assert.match(composerActions, /<PermissionModeSwitcher/)
  assert.match(composerActions, /<ModelPicker/)
  assert.match(composerActions, /<Paperclip/)
  assert.match(composerActions, /data-testid="context-ring"/)
  assert.match(composerActions, /<Send/)
  assert.doesNotMatch(composer, /QUICK_SKILLS|SlashAutocomplete|local-files-chat-action|onContextClick/)
})

test('chat supporting panels preserve a readable transcript on narrow screens', () => {
  const preview = read('../src/pages/ChatSplit/RightPreviewPane.jsx')
  const previewChrome = read('../src/pages/ChatSplit/preview/PreviewChrome.jsx')
  const styles = read('../src/index.css')

  assert.match(preview, /chat-preview-pane/)
  assert.match(previewChrome, /chat-preview-toolbar-actions/)
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?\.chat-preview-pane[\s\S]*?position: fixed;[\s\S]*?width: 100vw !important;/)
  assert.match(styles, /\.chat-preview-toolbar,\s*\.chat-preview-toolbar-actions\s*\{\s*flex-wrap: wrap;/)
})

test('skills open details before use and appearance offers a broader accent palette', () => {
  const skills = read('../src/pages/SkillsMarket.jsx')
  const skillsState = read('../src/pages/skillsMarket/useSkillsMarket.js')
  const skillDetail = read('../src/pages/skillsMarket/SkillDetailModal.jsx')
  const skillGrid = read('../src/pages/skillsMarket/SkillsGrid.jsx')
  const settings = read('../src/components/settings/SettingsSecondaryPanels.jsx')

  assert.match(skillsState, /const \[selectedSkill, setSelectedSkill\] = useState\(null\)/)
  assert.match(skillDetail, /role="dialog"/)
  assert.match(skills, /onUse=\{market\.useSelectedSkill\}/)
  assert.match(skillGrid, /onClick=\{\(\) => onSelect\(skill\)\}/)
  assert.match(skillGrid, /data-skill-open/)
  assert.doesNotMatch(skillGrid, /data-skill-action="details"/)
  assert.doesNotMatch(skillGrid, /skill\.categoryLabel|skill\.compatibility|skill\.pluginName|skill\.perms/)

  const palette = settings.match(/const ACCENT_COLORS = \[([^\]]+)\]/)?.[1] || ''
  assert.ok((palette.match(/#[0-9A-Fa-f]{6}/g) || []).length >= 8)
  assert.match(settings, /flex max-w-\[260px\] flex-wrap justify-end gap-2/)
  assert.match(settings, /<SettingsRow title=\{t\('settings\.accentColor'\)\}/)
})

test('skills and connections keep compact responsive surfaces across browser and desktop', () => {
  const skills = read('../src/pages/SkillsMarket.jsx')
  const skillsState = read('../src/pages/skillsMarket/useSkillsMarket.js')
  const skillGrid = read('../src/pages/skillsMarket/SkillsGrid.jsx')
  const access = read('../src/pages/AccessView.jsx')
  const accessPrimitives = read('../src/pages/access/AccessViewPrimitives.jsx')

  assert.match(skills, /max-w-\[1480px\]/)
  assert.match(skillsState, /catalogFallback/)
  assert.match(skillGrid, /grid-cols-1[\s\S]*sm:grid-cols-2[\s\S]*xl:grid-cols-3[\s\S]*2xl:grid-cols-4/)
  assert.doesNotMatch(access, /access\.eyebrow/)
  assert.doesNotMatch(accessPrimitives, /access-capability-legend/)
  assert.match(accessPrimitives, /access-capability-help/)
  assert.match(accessPrimitives, /access-capability-popover/)
})

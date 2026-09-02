import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Transitional debt ceiling. Counts exclude comments and translations.js.
// A migrated file naturally drops below its baseline; no file may increase,
// and a new source file starts with a zero allowance.
const BASELINE = {
  'src/App.jsx': 8,
  'src/components/ErrorBoundary.jsx': 73,
  'src/components/GlobalShortcuts.jsx': 13,
  'src/components/IntegrationsPanel.jsx': 26,
  'src/components/LeftRail.jsx': 346,
  'src/components/SkillCommandsSync.jsx': 8,
  'src/components/settings/SettingsDataExport.jsx': 215,
  'src/components/settings/SettingsDiagnosticsPanel.jsx': 164,
  'src/components/settings/SettingsModelsPanel.jsx': 26,
  'src/components/settings/SettingsSecondaryPanels.jsx': 140,
  'src/components/settings/SettingsToolsPanel.jsx': 267,
  'src/components/ToolApprovalCard.jsx': 9,
  'src/components/ToolCallCard.jsx': 88,
  'src/data.js': 5162,
  'src/lib/accessCatalog.js': 2,
  'src/lib/accountClient.js': 4,
  'src/lib/approvalClient.js': 4,
  'src/lib/artifactPreview.js': 58,
  'src/lib/attachments.js': 35,
  'src/lib/chatFlowGuards.js': 465,
  'src/lib/htmlSlidesToPptx.js': 61,
  'src/lib/localSkills.js': 12,
  'src/lib/loginCountdown.js': 9,
  'src/lib/modelClient.js': 171,
  'src/lib/officeExport.js': 6,
  'src/lib/officeExtract.js': 59,
  'src/lib/pptCore.js': 102,
  'src/lib/presentationExport.js': 239,
  'src/lib/presentationPlanner.js': 1670,
  'src/lib/reasonixClient.js': 4,
  'src/lib/sessionClient.js': 4,
  'src/lib/sessionExport.js': 60,
  'src/lib/settingsNavigation.js': 8,
  'src/lib/skillCommands.js': 163,
  'src/lib/toolApproval.js': 208,
  'src/lib/toolPermissionClient.js': 22,
  'src/lib/tools/index.js': 1302,
  'src/pages/AgentList.jsx': 10,
  'src/pages/ChatSplit/ArtifactPreview.jsx': 24,
  'src/pages/ChatSplit/ChatComposer.jsx': 54,
  'src/pages/ChatSplit/index.jsx': 906,
  'src/pages/ChatSplit/RightPreviewPane.jsx': 223,
  'src/pages/DeskView.jsx': 81,
  'src/pages/MemoryView.jsx': 248,
  'src/pages/MobileKeysView.jsx': 146,
  'src/pages/PermissionsDashboard.jsx': 61,
  'src/pages/ReasonixWorkspace.jsx': 301,
  'src/pages/SettingsView.jsx': 969,
  'src/pages/SkillsMarket.jsx': 326,
  'src/pages/TaskArtifactPreview.jsx': 72,
  'src/pages/TaskRunPanel.jsx': 226,
  'src/store/AppContext.jsx': 75,
  'src/store/exportSchema.js': 109,
  'src/store/taskStatus.js': 15,
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(js|jsx)$/.test(entry.name) ? [full] : []
  })
}

function stripComments(source) {
  let output = ''
  let state = 'code'
  let quote = ''
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line') {
      if (char === '\n') { state = 'code'; output += '\n' }
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; index += 1 }
      continue
    }
    if (state === 'string') {
      output += char
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === quote) { state = 'code'; quote = '' }
      continue
    }
    if (char === '/' && next === '/') { state = 'line'; index += 1; continue }
    if (char === '/' && next === '*') { state = 'block'; index += 1; continue }
    if (char === "'" || char === '"' || char === '`') { state = 'string'; quote = char }
    output += char
  }
  return output
}

test('frontend hardcoded Chinese cannot increase beyond the migration baseline', () => {
  const current = {}
  for (const file of walk('src')) {
    const relative = file.split(path.sep).join('/')
    if (
      relative === 'src/i18n/translations.js'
      || relative.startsWith('src/i18n/domains/')
      || relative === 'src/lib/skillPresentation.js'
    ) continue
    const count = (stripComments(readFileSync(file, 'utf8')).match(/[\u3400-\u9fff]/g) || []).length
    if (count > 0) current[relative] = count
  }

  const regressions = Object.entries(current)
    .filter(([file, count]) => count > (BASELINE[file] || 0))
    .map(([file, count]) => `${file}: ${count} > ${BASELINE[file] || 0}`)
  assert.deepEqual(regressions, [], `Move new UI copy into translations.js:\n${regressions.join('\n')}`)

  for (const migrated of [
    'src/components/ChoicePicker.jsx',
    'src/components/FileExplorer.jsx',
    'src/components/FullscreenMediaModal.jsx',
    'src/pages/ChatSplit/ChatMessages.jsx',
    'src/pages/HistoryView.jsx',
  ]) {
    assert.equal(current[migrated] || 0, 0, `${migrated} must remain fully migrated`)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('local account surfaces do not expose payment or balance controls', () => {
  const accountClient = read('../src/lib/accountClient.js')
  const accountPanel = read('../src/components/settings/SettingsAccountPanel.jsx')
  const diagnostics = read('../src/components/settings/SettingsDiagnosticsPanel.jsx')
  const rail = read('../src/components/LeftRail.jsx')

  assert.doesNotMatch(accountClient, /\/api\/billing|\brecharge\b/i)
  assert.doesNotMatch(accountPanel, /\brecharge\b|\bcredits\b|\bledger\b|\bpackages\b/i)
  assert.doesNotMatch(diagnostics, /diagnostics\?\.billing|basePer1k|multipliers/)
  assert.doesNotMatch(rail, /user\.credits|user\.plan/)
})

test('local mode hides mail diagnostics and links missing model configuration to Models', () => {
  const diagnostics = read('../src/components/settings/SettingsDiagnosticsPanel.jsx')
  const rail = read('../src/components/LeftRail.jsx')
  const settings = read('../src/pages/SettingsView.jsx')

  assert.match(diagnostics, /authMode !== 'local'[\s\S]*?<Group title="邮箱登录">/)
  assert.match(diagnostics, /authMode === 'local'[\s\S]*?model\?\.configured === false/)
  assert.match(diagnostics, /onClick=\{onConfigureModels\}/)
  assert.match(diagnostics, /t\('settings\.localAuthHint'\)/)
  assert.match(settings, /<SettingsDiagnosticsPanel authMode=\{state\.authMode\}[^>]*onConfigureModels=\{\(\) => setActiveNav\(SETTINGS_TAB_MODELS\)\}[^>]*t=\{t\}/)
  assert.match(rail, /if \(state\.authMode === 'local'\) return/)
  assert.match(rail, /item\.requiresLogin && !getAuthToken\(\) && state\.authMode !== 'local'/)
  assert.match(rail, /showLogin && state\.authMode !== 'local'/)
})

test('chat and Reasonix surfaces use completion and token statistics only', () => {
  const modelClient = read('../src/lib/modelClient.js')
  const tools = read('../src/lib/tools/index.js')
  const messages = read('../src/pages/ChatSplit/ChatMessages.jsx')
  const reasonix = read('../src/pages/ReasonixWorkspace.jsx')

  assert.match(modelClient, /type: 'complete'/)
  assert.doesNotMatch(modelClient, /type: 'billing'|chunk\.billing/)
  assert.doesNotMatch(tools, /output\.billing|data\.billing/)
  assert.doesNotMatch(messages, /creditsCharged|creditsBalance|billingError/)
  assert.doesNotMatch(reasonix, /costCredits|costRatio/)
})

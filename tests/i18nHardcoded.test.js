import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Exact transitional-debt ratchet. Counts exclude comments and translations.js.
// Every remaining allowance must match the current count, so cleanup forces the
// baseline down and a new source file always starts with a zero allowance.
const BASELINE = {
  'src/components/GlobalShortcuts.jsx': 13,
  'src/components/SkillCommandsSync.jsx': 8,
  'src/components/ToolApprovalCard.jsx': 9,
  'src/lib/accessCatalog.js': 2,
  'src/lib/accountClient.js': 4,
  'src/lib/approvalClient.js': 4,
  'src/lib/attachments.js': 35,
  'src/lib/localSkills.js': 12,
  'src/lib/loginCountdown.js': 9,
  'src/lib/officeExtract.js': 59,
  'src/lib/pptCore.js': 102,
  'src/lib/presentationPlanner.js': 1670,
  'src/lib/reasonixClient.js': 4,
  'src/lib/sessionExport.js': 60,
  'src/lib/skillCommands.js': 120,
  'src/lib/toolPermissionClient.js': 22,
  'src/pages/DeskView.jsx': 81,
  'src/pages/MobileKeysView.jsx': 146,
  'src/pages/ReasonixWorkspace.jsx': 276,
  'src/store/AppContext.jsx': 5,
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

  const staleAllowances = Object.entries(BASELINE)
    .filter(([file, count]) => (current[file] || 0) < count)
    .map(([file, count]) => `${file}: ${current[file] || 0} < ${count}`)
  assert.deepEqual(
    staleAllowances,
    [],
    `Ratchet cleaned hardcoded-Chinese allowances down to the current count:\n${staleAllowances.join('\n')}`,
  )

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

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * A source-order assertion (`source.indexOf(a) < source.indexOf(b)`) only proves
 * that two strings appear in a file in some order. Deleting or breaking the code
 * between them keeps the test green, so it cannot fail for the reason it claims.
 * Assert the observable behaviour instead - the existing ratchet entries are
 * migration debt, not a licence for new ones.
 *
 * Every allowance must match the current count exactly, so removing one forces
 * the baseline down and a new test file always starts at zero.
 */
const BASELINE = {
  'tests/artifactDownloadPreview.test.js': 1,
  'tests/batchFileTools.test.js': 1,
  'tests/builtinLifecycleAssembly.test.js': 16,
  'tests/chatSidebarAndDirectoryApproval.test.js': 4,
  'tests/desktopPackaging.test.js': 1,
  'tests/docxArtifactFormat.test.js': 2,
  'tests/docxPreview.test.js': 1,
  'tests/loopRuntime.test.js': 1,
  'tests/managedAttachmentStorageArchitecture.test.js': 1,
  'tests/runtimePluginInstallController.test.js': 1,
  'tests/sessionJsonlMaterializer.test.js': 1,
  'tests/turnCancellationRuntime.test.js': 2,
  'tests/turnEngine.test.js': 3,
  'tests/turnEventRoutes.test.js': 1,
  'tests/turnPersistenceAsyncAdapter.test.js': 7,
  'tests/workspaceInstructions.test.js': 2,
}

const ORDERING_ASSERTION = /\.(?:indexOf|lastIndexOf)\([^\n]*?[<>]=?[^\n]*?\.(?:indexOf|lastIndexOf)\(/u
// This file spells the anti-pattern out in the comment above, so it is exempt
// from its own scan.
const SELF = 'tests/sourceOrderAssertionBaseline.test.js'

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!/\.(?:js|jsx)$/u.test(entry.name)) return []
    return full.split(path.sep).join('/') === SELF ? [] : [full]
  })
}

function orderingAssertionCounts() {
  const counts = {}
  for (const file of walk('tests')) {
    const relative = file.split(path.sep).join('/')
    const count = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => ORDERING_ASSERTION.test(line))
      .length
    if (count > 0) counts[relative] = count
  }
  return counts
}

test('tests do not add source-order assertions instead of behavioural ones', () => {
  const current = orderingAssertionCounts()

  const added = Object.entries(current)
    .filter(([file, count]) => count > (BASELINE[file] || 0))
    .map(([file, count]) => `${file}: ${count} > ${BASELINE[file] || 0}`)
  assert.deepEqual(
    added,
    [],
    `Assert the behaviour these lines stand in for:\n${added.join('\n')}`,
  )

  const staleAllowances = Object.entries(BASELINE)
    .filter(([file, count]) => (current[file] || 0) < count)
    .map(([file, count]) => `${file}: ${current[file] || 0} < ${count}`)
  assert.deepEqual(
    staleAllowances,
    [],
    `Lower the source-order allowances to the current count:\n${staleAllowances.join('\n')}`,
  )

  assert.equal(
    current['tests/accessConnectionSafety.test.jsx'] || 0,
    0,
    'the converted example must stay behavioural',
  )
})

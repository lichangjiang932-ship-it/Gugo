import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { clearVerifiedMutationTargets } from '../server/services/loop/heuristics/mutationVerification.js'
import { PROJECT_SCOPE_TARGET } from '../server/services/loop/heuristics/constants.js'
import { normalizeMutationTarget } from '../server/services/loop/heuristics/mutationClassification.js'

// The workspace sentinel is the debt a command leaves when nobody can tell which
// files it touched (`node gen.js`). Any non-empty git diff used to clear it — a
// diff of the agent's own earlier, already verified edit included — even when
// the command's real output was an untracked file no diff shows.

const root = path.resolve('/work/project')
const diff = (file) => ({
  ok: true,
  repositoryRoot: root,
  executionCwd: root,
  diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`,
})

test('a diff of some tracked file clears that file but never the workspace sentinel', () => {
  const pending = new Set([PROJECT_SCOPE_TARGET, 'src/app.js'])
  assert.equal(clearVerifiedMutationTargets(pending, { name: 'git_diff', args: {} }, diff('src/app.js'), { projectDirectory: root }), true)
  assert.deepEqual([...pending], [PROJECT_SCOPE_TARGET], 'what node gen.js wrote is still unknown')
  // The same through a shell `git diff`.
  const viaShell = new Set([PROJECT_SCOPE_TARGET])
  clearVerifiedMutationTargets(viaShell, { name: 'run_command', args: { command: 'git diff' } },
    { ok: true, exitCode: 0, stdout: diff('README.md').diff, executionCwd: root }, { projectDirectory: root })
  assert.ok(viaShell.has(PROJECT_SCOPE_TARGET))
})

test('git status names what changed: the sentinel becomes those files, each still to verify', () => {
  const pending = new Set([PROJECT_SCOPE_TARGET])
  const status = { ok: true, root, clean: false, files: [{ status: '??', path: 'out.html' }, { status: ' M', path: 'src/app.js' }] }
  assert.equal(clearVerifiedMutationTargets(pending, { name: 'git_status', args: {} }, status, { projectDirectory: root }), true)
  assert.deepEqual([...pending].sort(), [
    normalizeMutationTarget(path.join(root, 'out.html')),
    normalizeMutationTarget(path.join(root, 'src/app.js')),
  ].sort())
})

test('a clean git status leaves nothing open; another repository proves nothing', () => {
  const pending = new Set([PROJECT_SCOPE_TARGET])
  clearVerifiedMutationTargets(pending, { name: 'git_status', args: {} }, { ok: true, root, clean: true, files: [] }, { projectDirectory: root })
  assert.equal(pending.size, 0)
  const elsewhere = new Set([PROJECT_SCOPE_TARGET])
  assert.equal(clearVerifiedMutationTargets(elsewhere, { name: 'git_status', args: {} },
    { ok: true, root: path.resolve('/other/repo'), clean: true, files: [] }, { projectDirectory: root }), false)
  assert.ok(elsewhere.has(PROJECT_SCOPE_TARGET))
})

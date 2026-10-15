#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
export const WORKTREE_BATCHES = Object.freeze([
  ['artifact-policy', []], ['foundation-ui', []], ['session-and-sidebar', ['foundation-ui']],
  ['usage-ledger', []], ['request-context-protocol', ['usage-ledger']], ['workbench-details', ['foundation-ui']],
  ['acceptance-and-stage-contracts', ['request-context-protocol']], ['evaluation-and-types', ['acceptance-and-stage-contracts']], ['docs-and-evidence', []],
])
const SHARED = new Set(['src/components/LeftRail.jsx', 'src/lib/turnClient/turnEventDispatch.js', 'src/lib/turnClient/sessionSnapshot.js',
  'shared/turnEvents.js', 'server/services/turnLoopExecutionRuntime.js', 'src/pages/ChatSplit/ChatSplitView.jsx', 'package.json'])
export function worktreeBatch(file) {
  if (/artifactFormat|artifactPolicyCheckpoint/.test(file)) return 'artifact-policy'
  if (file.startsWith('docs/') || file.startsWith('.agent/')) return 'docs-and-evidence'
  if (/FileNameLabel|Workbench|workbench|preview\//.test(file)) return 'workbench-details'
  if (/components\/ui\/|compositionEvent|chatComposerKeyGuard/.test(file)) return 'foundation-ui'
  if (/session|Session|LeftRail|leftRail|RequireAuth|AccountArea|mobile|LocalNoLogin|LocalAccount/.test(file)) return 'session-and-sidebar'
  if (/goalPlan|taskAcceptance|projectCheck|ProjectCheck|customVerification|verificationObservation|verification-stage|gitWorkbench|chatSplitStructure|chatSplitViewStructure|ChatHeader|usePlanCard/.test(file)) return 'acceptance-and-stage-contracts'
  if (file.startsWith('evals/') || file.startsWith('types/') || /type-fixtures|tsconfig|reliabilityEval/.test(file)) return 'evaluation-and-types'
  if (/UsageCoverage|usageLedger|UsageReport|localUsage|SettingsUsage|modelCacheStats|usageCoverage/.test(file)) return 'usage-ledger'
  return 'request-context-protocol'
}
export function buildWorktreeReview(files) {
  const batches = WORKTREE_BATCHES.map(([id, dependsOn]) => ({ id, dependsOn, files: [] }))
  for (const file of [...new Set(files)].sort()) batches.find(batch => batch.id === worktreeBatch(file)).files.push(file)
  return { schemaVersion: 1, automaticStaging: false, automaticCommit: false, automaticPush: false,
    batches, hunkReviewRequired: files.filter(file => SHARED.has(file)),
    note: 'Candidate groups, not independently validated commits. Shared-file hunks and import closure must be reviewed before staging.' }
}
export function reviewWorktree(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const modified = git(['ls-files', '--modified', '-z']).split('\0').filter(Boolean)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const files = [...new Set([...modified, ...untracked])]
  const review = buildWorktreeReview(files)
  const newFiles = new Set(untracked), edges = []
  for (const file of files.filter(file => /\.[cm]?[jt]sx?$/.test(file))) {
    if (/(?:^|\/)\.env|\.(?:key|pem|pfx|db|sqlite)$/i.test(file)) continue
    const full = path.join(root, file), stat = fs.lstatSync(full)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue
    const source = ts.createSourceFile(file, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.JS)
    for (const node of source.statements.filter(ts.isImportDeclaration)) {
      const name = node.moduleSpecifier.text
      if (!name.startsWith('.')) continue
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), name))
      const target = [base, base + '.js', base + '.jsx'].find(candidate => newFiles.has(candidate))
      if (target && worktreeBatch(file) !== worktreeBatch(target)) edges.push({ from: file, to: target })
    }
  }
  return { ...review, head: git(['rev-parse', 'HEAD']).trim(), trackedModified: modified.length, untrackedFiles: untracked.length,
    stagedFiles: git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean), crossBatchNewImports: edges }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(reviewWorktree(process.cwd()), null, 2) + '\n')
}

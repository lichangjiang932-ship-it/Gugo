#!/usr/bin/env node
/**
 * Prove that the isolated demo runtime cannot fall back to the user's real data.
 *
 * Run after `prepare-isolated-workspace.mjs`:
 *   node scripts/cli-demo/verify-isolation.mjs --root output/cli-demo/<run>
 *
 * Checks:
 *   1. Resolved APP_DATA_DIR / APP_DB_PATH / ARTIFACT_DIR stay inside <root>/runtime.
 *   2. They never resolve to the repository's real server-data directory.
 *   3. A hostile .env inside the task workspace relocates nothing when the CLI
 *      runs from the repository root (runtime cwd != --cwd).
 *   4. Acceptance verifier scripts and fixtures stay outside every workspace.
 *   5. Each workspace is a real disposable copy, not the fixture source.
 */
import fs from 'node:fs'
import path from 'node:path'

import { resolveRuntimeStartupEnvironment } from '../../server/utils/runtimeEnv.js'

function parseArgs(argv) {
  const options = { root: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    if (raw === '--root') { options.root = String(argv[++index] || ''); continue }
    if (raw.startsWith('--root=')) { options.root = raw.slice('--root='.length); continue }
    throw new Error(`unknown argument: ${raw}`)
  }
  return options
}

function inside(candidate, container) {
  const relative = path.relative(path.resolve(container), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

const HOSTILE_ENV = [
  'APP_DATA_DIR=./hostile-data',
  'APP_DB_PATH=./hostile-data/hostile.db',
  'ARTIFACT_DIR=./hostile-artifacts',
  'WORKSPACE_ROOT=.',
  '',
].join('\n')

function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = path.resolve(options.root || path.join(process.cwd(), 'output', 'cli-demo'))
  const manifestPath = path.join(root, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const checks = []
  const record = (name, ok, detail = '') => checks.push({ name, ok, detail })

  const runtimeRoot = manifest.runtimeRoot
  const repoRoot = manifest.repoRoot
  const realDataDir = path.join(repoRoot, 'server-data')

  // 1/2. Resolved runtime storage stays inside the isolated runtime root.
  const resolved = resolveRuntimeStartupEnvironment({ cwd: repoRoot, env: manifest.env })
  for (const key of ['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR']) {
    const value = resolved[key]
    record(
      `runtime.${key}.inside_isolated_root`,
      inside(value, runtimeRoot),
      value,
    )
    record(
      `runtime.${key}.not_real_user_data`,
      !inside(value, realDataDir),
      value,
    )
  }
  record(
    'runtime.db_uses_isolated_data_dir',
    inside(resolved.APP_DB_PATH, resolved.APP_DATA_DIR),
    resolved.APP_DB_PATH,
  )

  // 3. A hostile workspace .env must not relocate the runtime when the CLI runs
  //    from the repository root (the runtime cwd is not the task workspace).
  for (const task of manifest.tasks) {
    const hostilePath = path.join(task.workspace, '.env')
    const previous = fs.existsSync(hostilePath) ? fs.readFileSync(hostilePath, 'utf8') : null
    fs.writeFileSync(hostilePath, HOSTILE_ENV)
    try {
      const after = resolveRuntimeStartupEnvironment({ cwd: repoRoot, env: manifest.env })
      record(
        `workspace.${task.id}.env_cannot_relocate_runtime`,
        samePath(after.APP_DB_PATH, resolved.APP_DB_PATH)
          && inside(after.APP_DB_PATH, runtimeRoot),
        after.APP_DB_PATH,
      )
    } finally {
      if (previous === null) fs.rmSync(hostilePath, { force: true })
      else fs.writeFileSync(hostilePath, previous)
    }
  }

  // 4/5. Acceptance scripts and fixtures stay outside the workspace; the copy is
  //      a real, separate directory.
  for (const task of manifest.tasks) {
    for (const verifier of task.verifiers) {
      record(
        `task.${task.id}.verifier_outside_workspace`,
        !inside(verifier, task.workspace) && fs.existsSync(verifier),
        verifier,
      )
    }
    record(
      `task.${task.id}.fixture_outside_workspace`,
      !inside(task.fixtureSource, task.workspace),
      task.fixtureSource,
    )
    record(
      `task.${task.id}.workspace_is_disposable_copy`,
      fs.existsSync(task.workspace) && !samePath(task.workspace, task.fixtureSource),
      task.workspace,
    )
  }

  const ok = checks.every((check) => check.ok)
  process.stdout.write(`${JSON.stringify({ ok, root, checks }, null, 2)}\n`)
  return ok ? 0 : 1
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`[cli-demo] isolation verification failed: ${error?.message || error}\n`)
  process.exitCode = 1
}

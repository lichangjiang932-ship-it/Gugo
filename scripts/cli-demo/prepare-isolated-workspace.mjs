#!/usr/bin/env node
/**
 * Prepare a disposable, isolated CLI demo environment.
 *
 * Layout under <root>:
 *   runtime/data/       APP_DATA_DIR + app.db
 *   runtime/artifacts/  ARTIFACT_DIR
 *   runtime/logs/       CLI stdout/stderr captures
 *   runtime/env.json    storage overrides (no secrets), AUTH_MODE=local
 *   tasks/<id>/workspace   disposable copy of the fixture workspace
 *   manifest.json       resolved paths + acceptance script paths
 *
 * The task workspace and the trusted runtime directory are deliberately
 * separate: `--cwd` only selects the task workspace. Acceptance scripts stay
 * under evals/ in the repository, never inside the model-writable workspace.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SUITE_PATH = path.join(REPO_ROOT, 'evals', 'starter-suite.json')

function parseArgs(argv) {
  const options = { root: '', task: '', all: false }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    if (raw === '--all') { options.all = true; continue }
    if (raw === '--root') { options.root = String(argv[++index] || ''); continue }
    if (raw === '--task') { options.task = String(argv[++index] || ''); continue }
    if (raw.startsWith('--root=')) { options.root = raw.slice('--root='.length); continue }
    if (raw.startsWith('--task=')) { options.task = raw.slice('--task='.length); continue }
    throw new Error(`unknown argument: ${raw}`)
  }
  return options
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`fixture must not contain symlinks: ${from}`)
    if (entry.isDirectory()) copyDirectory(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const suite = JSON.parse(fs.readFileSync(SUITE_PATH, 'utf8'))
  const selected = options.all
    ? suite.tasks
    : suite.tasks.filter((task) => task.id === (options.task || suite.tasks[0].id))
  if (selected.length === 0) throw new Error(`no matching task for --task ${options.task}`)

  const root = path.resolve(
    options.root || path.join(REPO_ROOT, 'output', 'cli-demo', timestamp()),
  )
  const runtimeRoot = path.join(root, 'runtime')
  const dataDir = path.join(runtimeRoot, 'data')
  const artifactDir = path.join(runtimeRoot, 'artifacts')
  const logsDir = path.join(runtimeRoot, 'logs')
  for (const dir of [dataDir, artifactDir, logsDir]) fs.mkdirSync(dir, { recursive: true })

  const env = Object.freeze({
    AUTH_MODE: 'local',
    APP_DATA_DIR: dataDir,
    APP_DB_PATH: path.join(dataDir, 'app.db'),
    ARTIFACT_DIR: artifactDir,
    // Do not inherit a user's model configuration into the demo runtime.
    GUGO_LOAD_DOTENV: '0',
  })
  fs.writeFileSync(path.join(runtimeRoot, 'env.json'), `${JSON.stringify(env, null, 2)}\n`)

  const tasks = selected.map((task) => {
    const fixture = path.resolve(REPO_ROOT, 'evals', task.workspace)
    if (!fs.existsSync(fixture)) throw new Error(`fixture missing: ${fixture}`)
    const workspace = path.join(root, 'tasks', task.id, 'workspace')
    copyDirectory(fixture, workspace)
    return {
      id: task.id,
      prompt: task.prompt,
      mode: task.mode,
      timeoutMs: task.timeoutMs,
      fixtureSource: fixture,
      workspace,
      // Acceptance scripts live in the repo, outside the model-writable workspace.
      verifiers: (task.verify || []).map((entry) => path.resolve(REPO_ROOT, 'evals', entry.script)),
    }
  })

  const manifest = Object.freeze({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    root,
    runtimeRoot,
    env,
    tasks,
  })
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const first = tasks[0]
  process.stdout.write(`${JSON.stringify({ ok: true, root, manifest: path.join(root, 'manifest.json'), tasks }, null, 2)}\n`)
  process.stderr.write(`[cli-demo] prepared ${tasks.length} isolated task(s) under ${root}\n`)
  process.stderr.write('[cli-demo] run from the repository root so the task workspace cannot select runtime config:\n')
  process.stderr.write(`  cd ${REPO_ROOT}\n`)
  process.stderr.write(`  node bin/yma-cli.js doctor --headless --cwd "${first.workspace}"\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[cli-demo] ${error?.message || error}\n`)
  process.exitCode = 1
}

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREPARE = path.join(REPO_ROOT, 'scripts', 'cli-demo', 'prepare-isolated-workspace.mjs')
const VERIFY = path.join(REPO_ROOT, 'scripts', 'cli-demo', 'verify-isolation.mjs')

function runNode(script, args) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('demo isolation scripts keep runtime state out of the task workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-cli-demo-'))
  try {
    const prepared = JSON.parse(runNode(PREPARE, ['--all', '--root', root]))
    assert.equal(prepared.ok, true)
    assert.ok(prepared.tasks.length >= 1)

    const verified = JSON.parse(runNode(VERIFY, ['--root', root]))
    assert.equal(verified.ok, true, JSON.stringify(verified.checks.filter((check) => !check.ok)))
    assert.ok(verified.checks.length > 0)
    for (const name of [
      'runtime.APP_DB_PATH.inside_isolated_root',
      'runtime.APP_DB_PATH.not_real_user_data',
      'runtime.ARTIFACT_DIR.inside_isolated_root',
      'runtime.APP_DATA_DIR.not_real_user_data',
    ]) {
      assert.equal(
        verified.checks.find((check) => check.name === name)?.ok,
        true,
        `isolation check failed: ${name}`,
      )
    }

    // The workspace copy is mutated by a task; the fixture source must stay clean.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    const task = manifest.tasks[0]
    const workspaceFile = path.join(task.workspace, 'package.json')
    fs.writeFileSync(workspaceFile, '{"tampered":true}\n')
    assert.notEqual(
      fs.readFileSync(workspaceFile, 'utf8'),
      fs.readFileSync(path.join(task.fixtureSource, 'package.json'), 'utf8'),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

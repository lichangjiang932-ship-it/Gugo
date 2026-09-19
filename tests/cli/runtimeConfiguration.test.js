import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const CLI = fileURLToPath(new URL('../../bin/yma-cli.js', import.meta.url))
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const importGuard = dataUrl(`
  export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context)
    if (/\\/server\\/(?:db\\.js|services\\/(?!goalPlanEvidence\\.js$)|adapters\\/(?!modelProviderConfig\\.js))/.test(result.url)
        || /(?:better-sqlite3|node:sqlite)/.test(result.url)) {
      throw Object.assign(new Error('CONFIG_RUNTIME_TOUCHED'), { code: 'CONFIG_RUNTIME_TOUCHED' })
    }
    return result
  }
`)
const preload = dataUrl(`
  import { register } from 'node:module'
  import { Socket } from 'node:net'
  register(${JSON.stringify(importGuard)}, import.meta.url)
  const denied = () => { throw new Error('CONFIG_NETWORK_OR_STDIN_TOUCHED') }
  globalThis.fetch = denied
  Socket.prototype.connect = denied
  process.stdin[Symbol.asyncIterator] = denied
`)

function snapshot(directory) {
  const entries = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    entries.push([entry.name, entry.isDirectory() ? snapshot(filename)
      : createHash('sha256').update(readFileSync(filename)).digest('hex')])
  }
  return entries.sort(([left], [right]) => left.localeCompare(right))
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gugo-runtime-selection-'))
  const runtime = path.join(root, 'installed-runtime')
  const workspace = path.join(root, 'project')
  const data = path.join(runtime, 'shared-data')
  for (const directory of [runtime, workspace, data, path.join(runtime, '.gugo')]) mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(runtime, '.env'), 'MODEL_API_KEY=fixture-do-not-print\nSERVER_PORT=5180\n')
  writeFileSync(path.join(runtime, '.gugo', 'runtime.json'), JSON.stringify({ env: { MEMORY_EMBEDDINGS_ENABLED: '0' } }))
  writeFileSync(path.join(data, 'runtime.json'), JSON.stringify({ env: {
    WORKSPACE_FS_ENABLED: '0', GUGO_RUNTIME_CWD: path.join(root, 'untrusted-relocation'),
  } }))
  writeFileSync(path.join(workspace, '.env'), 'APP_DATA_DIR=must-not-use-project-data\nMODEL_API_KEY=project-secret\n')
  const env = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TMP: root, TEMP: root, TMPDIR: root,
    APP_DATA_DIR: data, APP_DB_PATH: path.join(data, 'app.db'), ARTIFACT_DIR: path.join(data, 'artifacts'),
    AUTH_MODE: 'local', ANTHROPIC_API_KEY: 'second-private-fixture',
  }
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runtime, workspace, data, env, run(args, extraEnv = {}) {
    const before = snapshot(root)
    const result = spawnSync(process.execPath, ['--import', preload, CLI, ...args], {
      cwd: workspace, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    assert.equal(result.error, undefined, result.stderr)
    assert.deepEqual(snapshot(root), before, 'configuration inspection must leave all files byte-identical')
    return result
  } }
}

test('config resolves the selected runtime without bootstrapping storage, opening credential stores, or contacting a server', (t) => {
  const f = fixture(t)
  const result = f.run(['--runtime-dir', f.runtime, 'config', '--json'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.readOnly, true)
  assert.equal(report.runtime.cwd, f.runtime)
  assert.equal(report.runtime.source, 'argument')
  assert.equal(report.runtime.dataDir, f.data)
  assert.equal(report.runtime.dbPath, path.join(f.data, 'app.db'))
  assert.equal(report.runtime.artifactDir, path.join(f.data, 'artifacts'))
  assert.equal(report.configuration.paths.user, path.join(f.data, 'runtime.json'))
  assert.equal(report.configuration.paths.project, path.join(f.runtime, '.gugo', 'runtime.json'))
  assert.deepEqual(report.configuration.precedence, ['user_config', 'project_config', 'explicit_config', '.env', 'environment'])
  assert.equal(report.settings.url, 'http://127.0.0.1:5180/#/settings')
  assert.equal(report.settings.verified, false)
  assert.equal(report.identity.inspected, false)
  assert.equal(report.identity.credentialStoreOpened, false)
  assert.match(report.permissions.defaultPolicy, /plan/u)
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-do-not-print|project-secret|second-private-fixture/u)
})

test('launcher runtime selection is explicit, CLI wins, and runtime JSON cannot self-relocate it', (t) => {
  const f = fixture(t)
  const fromEnv = f.run(['config', '--json'], { GUGO_RUNTIME_CWD: f.runtime })
  assert.equal(fromEnv.status, 0, fromEnv.stderr)
  assert.equal(JSON.parse(fromEnv.stdout).runtime.cwd, f.runtime)
  assert.equal(JSON.parse(fromEnv.stdout).runtime.source, 'environment')
  const fromFlag = f.run(['--runtime-dir=' + f.runtime, 'config', '--json'], { GUGO_RUNTIME_CWD: f.workspace })
  assert.equal(fromFlag.status, 0, fromFlag.stderr)
  assert.equal(JSON.parse(fromFlag.stdout).runtime.cwd, f.runtime)
  const defaulted = f.run(['config', '--json'])
  assert.equal(defaulted.status, 0, defaulted.stderr)
  assert.equal(JSON.parse(defaulted.stdout).runtime.cwd, f.workspace)
  assert.equal(JSON.parse(defaulted.stdout).runtime.source, 'cwd')
})

test('runtime flag and config argument errors fail before runtime file reads', (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.data, 'runtime.json'), '{invalid runtime JSON')
  for (const [args, code] of [
    [['--runtime-dir'], 'CLI_OPTION_VALUE_REQUIRED'],
    [['--runtime-dir', '--help'], 'CLI_OPTION_VALUE_REQUIRED'],
    [['--runtime-dir', f.runtime, '--runtime-dir', f.workspace, 'config'], 'CLI_OPTION_DUPLICATE'],
    [['--runtime-dir', f.runtime, 'config', '--bogus'], 'CLI_OPTION_UNKNOWN'],
    [['config', 'extra'], 'CLI_ARGUMENT_UNEXPECTED'],
  ]) {
    const result = f.run(args)
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.ok((result.stdout + result.stderr).includes(code), result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /RUNTIME_CONFIG_FILE_INVALID/u)
  }
  const help = f.run(['--runtime-dir', path.join(f.root, 'missing'), 'config', '--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /gugo config/u)
})

test('config shows a credential-free settings link only and refuses unsafe server URLs', (t) => {
  const f = fixture(t)
  const report = f.run(['--runtime-dir', f.runtime, 'config', '--json'], { GUGO_SERVER_URL: 'https://example.invalid/gugo' })
  assert.equal(report.status, 0, report.stderr)
  assert.equal(JSON.parse(report.stdout).settings.url, 'https://example.invalid/gugo/#/settings')
  const target = new URL(JSON.parse(report.stdout).settings.url)
  assert.equal(target.pathname, '/gugo/')
  assert.equal(target.hash, '#/settings')
  assert.equal(JSON.parse(report.stdout).settings.verified, false)
  const invalid = f.run(['config'], { GUGO_SERVER_URL: 'https://owner:private-secret@example.invalid' })
  assert.equal(invalid.status, 2, invalid.stderr)
  assert.match(invalid.stderr, /CLI_SERVER_URL_INVALID/u)
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-secret/u)
})

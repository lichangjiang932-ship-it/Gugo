import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const url = (file) => new URL(`../../${file}`, import.meta.url).href
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const hostUrl = url('server/adapters/headlessTurnHost.js')
const hostSource = `export async function runBuiltinHeadlessTurn(options) {
  return { runtimeCwd: options.runtimeCwd, taskCwd: options.cwd, shell: options.env.WORKSPACE_SHELL_ENABLED ?? null,
    processShell: process.env.WORKSPACE_SHELL_ENABLED ?? null, database: options.env.APP_DB_PATH }
}`
const loader = dataUrl(`
  export async function load(url, context, nextLoad) {
    if (url === ${JSON.stringify(hostUrl)}) return { format: 'module', source: ${JSON.stringify(hostSource)}, shortCircuit: true }
    return nextLoad(url, context)
  }
`)
const preload = dataUrl(`
  import { register } from 'node:module'
  import { Socket } from 'node:net'
  register(${JSON.stringify(loader)}, import.meta.url)
  globalThis.fetch = () => { throw new Error('UNEXPECTED_MODEL_REQUEST') }
  Socket.prototype.connect = () => { throw new Error('UNEXPECTED_NETWORK') }
`)

function fixture(t, script, { shell = '0' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gugo-config-reload-'))
  const runtime = path.join(root, 'runtime')
  const workspace = path.join(root, 'workspace')
  const data = path.join(runtime, 'data')
  for (const directory of [runtime, workspace, data]) mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(data, 'runtime.json'), JSON.stringify({ env: {
    WORKSPACE_FS_ENABLED: '1', WORKSPACE_SHELL_ENABLED: shell,
    WORKSPACE_GIT_ENABLED: '0', WORKSPACE_GIT_MUTATION_ENABLED: '0',
  } }))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    const { loadBuiltinHeadlessRuntime } = await import(${JSON.stringify(url('bin/cli/headlessRuntimeLoader.js'))})
    const { updateWorkspaceRuntimeConfiguration } = await import(${JSON.stringify(url('server/utils/runtimeEnv.js'))})
    const launchEnv = Object.freeze({ ...process.env })
    const runtimeCwd = process.env.FIXTURE_RUNTIME_DIR
    const configPath = path.join(process.env.APP_DATA_DIR, 'runtime.json')
    const run = await loadBuiltinHeadlessRuntime({ runtimeCwd, env: launchEnv })
    try { ${script} }
    finally { const { closeDb } = await import(${JSON.stringify(url('server/db.js'))}); closeDb() }
  `
  const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '--eval', source], {
    cwd: workspace, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TMP: root, TEMP: root, TMPDIR: root,
      APP_DATA_DIR: data, ARTIFACT_DIR: path.join(data, 'artifacts'), GUGO_LOAD_DOTENV: '0', AUTH_MODE: 'local',
      FIXTURE_RUNTIME_DIR: runtime },
  })
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return { report: JSON.parse(result.stdout.trim()), runtime, workspace, data }
}

test('the real CLI loader re-reads web-saved configuration for each turn from its original trusted root', (t) => {
  const { report, runtime, workspace } = fixture(t, `
    const before = await run({ cwd: process.cwd() })
    updateWorkspaceRuntimeConfiguration({ cwd: runtimeCwd, env: launchEnv, features: {
      WORKSPACE_FS_ENABLED: true, WORKSPACE_SHELL_ENABLED: true, WORKSPACE_GIT_ENABLED: false,
      WORKSPACE_GIT_MUTATION_ENABLED: false,
    } })
    const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    document.env.GUGO_RUNTIME_CWD = process.cwd()
    fs.writeFileSync(configPath, JSON.stringify(document))
    const after = await run({ cwd: process.cwd(), env: { WORKSPACE_SHELL_ENABLED: 'caller-must-not-override' } })
    process.stdout.write(JSON.stringify({ before, after }))
  `)
  assert.equal(report.before.shell, '0')
  assert.equal(report.after.shell, '1')
  assert.equal(report.after.runtimeCwd, runtime)
  assert.equal(report.after.taskCwd, workspace)
  assert.equal(report.after.database, report.before.database)
})

test('removing a runtime setting also removes the old applied process value used by real consumers', (t) => {
  const { report } = fixture(t, `
    const before = await run({ cwd: process.cwd() })
    const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    delete document.env.WORKSPACE_SHELL_ENABLED
    fs.writeFileSync(configPath, JSON.stringify(document))
    const after = await run({ cwd: process.cwd() })
    process.stdout.write(JSON.stringify({ before, after }))
  `, { shell: '1' })
  assert.equal(report.before.shell, '1')
  assert.equal(report.after.shell, null)
  assert.equal(report.after.processShell, null)
})

test('a changed database identity is refused before changing process paths or creating another database', (t) => {
  const { report, data } = fixture(t, `
    const first = await run({ cwd: process.cwd() })
    const wrongDatabase = path.join(process.env.APP_DATA_DIR, 'other.db')
    const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    document.env.APP_DB_PATH = wrongDatabase
    fs.writeFileSync(configPath, JSON.stringify(document))
    let code = null
    try { await run({ cwd: process.cwd() }) } catch (error) { code = error.code }
    process.stdout.write(JSON.stringify({ code, first, processDatabase: process.env.APP_DB_PATH,
      wrongDatabaseExists: fs.existsSync(wrongDatabase) }))
  `)
  assert.equal(report.code, 'RUNTIME_CONFIG_IDENTITY_CHANGED_DURING_PREFLIGHT')
  assert.equal(report.processDatabase, path.join(data, 'app.db'))
  assert.equal(report.wrongDatabaseExists, false)
})

test('an already cancelled turn does not reload or recover configuration before respecting its signal', (t) => {
  const { report } = fixture(t, `
    fs.writeFileSync(configPath, '{changed invalid config must not be read for a cancelled turn')
    const controller = new AbortController()
    const reason = Object.assign(new Error('cancelled fixture'), { code: 'FIXTURE_CANCELLED' })
    controller.abort(reason)
    let identical = false
    let code = null
    try { await run({ cwd: process.cwd(), signal: controller.signal }) }
    catch (error) { identical = error === reason; code = error.code }
    process.stdout.write(JSON.stringify({ identical, code }))
  `)
  assert.deepEqual(report, { identical: true, code: 'FIXTURE_CANCELLED' })
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sanitizeChildEnv } from '../server/utils/sensitiveEnv.js'
import { createWindowsTreeKillWorkerManager, windowsTreeKillTesting } from '../server/utils/windowsTreeKillRuntime.js'
import { prepareWindowsProcessExecution } from '../server/utils/windowsProcessGateRuntime.js'
import { windowsPowerShellPath, windowsTreeKillWorkerArgs, windowsTreeKillWorkerScript } from '../server/utils/windowsTreeKillWorkerSource.js'

const WINDOWS_ONLY = { skip: process.platform !== 'win32', timeout: 90_000 }
const SHADOW_MARKER = 'GUGO_SHADOW_ADD_TYPE_EXECUTED'

function createShadowModule(directory) {
  const moduleRoot = path.join(directory, 'Microsoft.PowerShell.Utility')
  fs.mkdirSync(moduleRoot, { recursive: true })
  fs.writeFileSync(path.join(moduleRoot, 'Microsoft.PowerShell.Utility.psd1'), `@{
RootModule = 'Microsoft.PowerShell.Utility.psm1'
ModuleVersion = '99.0.0'
GUID = '1ee43f37-4086-4a32-999e-613e04acecf7'
FunctionsToExport = @('Add-Type', 'New-Object')
CmdletsToExport = @()
AliasesToExport = @()
}`, 'utf8')
  fs.writeFileSync(path.join(moduleRoot, 'Microsoft.PowerShell.Utility.psm1'), `
[IO.File]::AppendAllText($env:GUGO_MODULE_PROBE_LOG, "IMPORTED\n")
function Add-Type {
  param([string] $TypeDefinition)
  [IO.File]::AppendAllText($env:GUGO_MODULE_PROBE_LOG, "${SHADOW_MARKER}\n")
  throw '${SHADOW_MARKER}'
}
function New-Object {
  [IO.File]::AppendAllText($env:GUGO_MODULE_PROBE_LOG, "GUGO_SHADOW_NEW_OBJECT_EXECUTED\n")
  throw 'GUGO_SHADOW_NEW_OBJECT_EXECUTED'
}
Microsoft.PowerShell.Core\\Export-ModuleMember -Function Add-Type, New-Object
`, 'utf8')
}

function trackChild(children, command, args, options) {
  const child = spawn(command, args, options)
  const record = { child, stdout: '', stderr: '', error: null, closed: null }
  record.closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  child.on('error', (error) => { record.error = error.code || error.message })
  child.stdout?.setEncoding('utf8').on('data', (chunk) => { record.stdout = (record.stdout + chunk).slice(-16_384) })
  child.stderr?.setEncoding('utf8').on('data', (chunk) => { record.stderr = (record.stderr + chunk).slice(-16_384) })
  children.push(record)
  return record
}

async function waitForChildClose(record, timeoutMs = 5_000) {
  let timer
  try {
    return await Promise.race([
      record.closed,
      new Promise((_, reject) => {
        // Keep this timer referenced: the production manager unrefs an idle or
        // stopped worker, but test teardown must still observe its close event.
        timer = setTimeout(() => reject(new Error(`test-owned child ${record.child.pid} did not close`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function closeFixtureChildren(children) {
  const failures = []
  for (const record of children) {
    const { child } = record
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL') } catch { /* this test-owned child already exited */ }
    }
    try { await waitForChildClose(record) } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'isolated dependency fixture processes did not close')
}

async function withShadowFixture(run) {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'gugo-worker-dependency-'))
  const children = []
  try {
    const directories = Object.fromEntries(['modules', 'profile', 'roaming', 'local', 'temp']
      .map((name) => [name, path.join(root, name)]))
    for (const directory of Object.values(directories)) fs.mkdirSync(directory)
    createShadowModule(directories.modules)
    const env = sanitizeChildEnv({
      PSModulePath: directories.modules,
      PSModuleAnalysisCachePath: path.join(directories.local, 'ModuleAnalysisCache'),
      HOME: directories.profile, USERPROFILE: directories.profile,
      APPDATA: directories.roaming, LOCALAPPDATA: directories.local,
      TEMP: directories.temp, TMP: directories.temp, TMPDIR: directories.temp,
    })
    return await run({
      root, env, children,
      launch: (command, args, options) => trackChild(children, command, args, options),
    })
  } finally {
    await closeFixtureChildren(children)
    assert.equal(path.dirname(fs.realpathSync(root)), parent)
    assert.ok(path.basename(root).startsWith('gugo-worker-dependency-'))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

async function confirmShadowAutoload(fixture) {
  const marker = path.join(fixture.root, 'control-marker.log')
  const control = fixture.launch(windowsPowerShellPath(), windowsTreeKillWorkerArgs(), {
    cwd: fixture.root, env: { ...fixture.env, GUGO_MODULE_PROBE_LOG: marker },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(30_000),
  })
  const source = `[Console]::Out.WriteLine('VERSION=' + $PSVersionTable.PSVersion.Major + '.' + $PSVersionTable.PSVersion.Minor)
Add-Type -TypeDefinition 'public static class GugoShadowControl {}'`
  control.child.stdin.end(Buffer.from(source, 'utf8').toString('base64') + '\n')
  const outcome = await waitForChildClose(control, 35_000)
  const diagnostic = JSON.stringify({ ...outcome, error: control.error, stdout: control.stdout, stderr: control.stderr })
  assert.match(control.stdout, /VERSION=5\.1/u, diagnostic)
  assert.equal(control.error, null, diagnostic)
  assert.notEqual(outcome.code, 0, diagnostic)
  assert.match(control.stderr, new RegExp(SHADOW_MARKER, 'u'), diagnostic)
  assert.equal(fs.readFileSync(marker, 'utf8'), `IMPORTED\n${SHADOW_MARKER}\n`)
}

test('Windows dependency fixture proves unqualified Add-Type loads its isolated shadow Utility module', WINDOWS_ONLY, async () => {
  await withShadowFixture(confirmShadowAutoload)
})

test('Windows cleanup worker ignores shadow Utility commands and binds a real native process identity', WINDOWS_ONLY, async (t) => {
  await withShadowFixture(async (fixture) => {
    // The control uses the very same module path and startup arguments. A
    // passing worker without this control could merely mean the fixture never
    // shadowed Add-Type on the machine running the test.
    await confirmShadowAutoload(fixture)
    const marker = path.join(fixture.root, 'worker-marker.log')
    const manager = createWindowsTreeKillWorkerManager({
      spawnProcess: (command, args, options) => fixture.launch(command, args, {
        ...options, env: { ...fixture.env, GUGO_MODULE_PROBE_LOG: marker },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).child,
    })
    try {
      try {
        await manager.ready({ timeoutMs: 30_000 })
      } catch (error) {
        t.diagnostic(`dependency probe: ${JSON.stringify({ code: error.code,
          shadowMarker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null })}`)
        throw error
      }
      assert.equal(fs.existsSync(marker), false, 'worker must not load or execute the ambient shadow module')
      const target = fixture.launch(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        cwd: fixture.root, env: fixture.env, windowsHide: true, stdio: 'ignore',
      })
      await new Promise((resolve, reject) => {
        target.child.once('spawn', resolve)
        target.child.once('error', reject)
      })
      const lease = await manager.bind(target.child.pid)
      assert.ok(lease, 'the trusted native implementation must bind the test-owned live process')
      assert.equal(await manager.kill(lease), true, 'the trusted implementation must verify the bound tree was terminated')
      await waitForChildClose(target)
      assert.equal(fs.existsSync(marker), false)
    } finally {
      manager.shutdown()
    }
  })
})

test('Windows cleanup worker cannot fall back to an ambient module when its fixed system dependency is missing', WINDOWS_ONLY, async () => {
  await withShadowFixture(async (fixture) => {
    await confirmShadowAutoload(fixture)
    const marker = path.join(fixture.root, 'missing-dependency-marker.log')
    const missingManifest = path.join(fixture.root, 'missing-system-module', 'Microsoft.PowerShell.Utility.psd1')
    assert.equal(fs.existsSync(missingManifest), false)
    const anchor = "$utilityPath = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')"
    const source = windowsTreeKillWorkerScript()
    assert.equal(source.split(anchor).length, 2, 'fault injection must replace exactly the fixed dependency path')
    const faultSource = source.replace(anchor, `$utilityPath = '${missingManifest.replaceAll("'", "''")}'`)
    const manager = createWindowsTreeKillWorkerManager({
      workerPayload: Buffer.from(faultSource, 'utf8').toString('base64'),
      spawnProcess: (command, args, options) => fixture.launch(command, args, {
        ...options, env: { ...fixture.env, GUGO_MODULE_PROBE_LOG: marker },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).child,
    })
    windowsTreeKillTesting.setManager(manager)
    try {
      let executions = 0
      const result = await prepareWindowsProcessExecution({ timeout: 35_000 }, () => { executions += 1 })
      assert.equal(executions, 0, 'a missing trusted dependency must never admit the requested command')
      assert.equal(result.processIsolationFailed, true)
      assert.equal(result.timedOut, false)
      assert.equal(result.aborted, false)
      assert.equal(result.stdout, '')
      assert.match(result.processIsolationError, /startup phase=utility_import_begin/u)
      assert.equal(fs.existsSync(marker), false, 'dependency failure must not fall back to the searchable shadow module')
      assert.equal(manager.snapshot().ready, false)
      assert.equal(manager.snapshot().active, false)
    } finally {
      windowsTreeKillTesting.reset()
    }
  })
})

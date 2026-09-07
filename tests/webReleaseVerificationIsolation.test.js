import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const verificationScript = path.join(projectRoot, 'scripts/release/verify-web-release.ps1')
const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
const nativeEnvironmentKeys = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE',
])
const nativeEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => nativeEnvironmentKeys.has(key.toUpperCase())))
const powerShell = (process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'])
  .find((command) => spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    env: nativeEnvironment, timeout: 10_000, windowsHide: true,
  }).status === 0)
const isolatedPathKeys = [
  'APP_DATA_DIR', 'APP_DB_PATH', 'APP_CONFIG_PATH', 'ARTIFACT_DIR', 'WORKSPACE_ROOT',
  'TEMP', 'TMP', 'TMPDIR', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_DEVDIR',
  'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG',
]
const blockedEnvironmentKeys = [
  'GUGO_TURN_PERSISTENCE_MODULE', 'GUGO_TURN_PERSISTENCE_TRUST_ROOT',
  'NODE_OPTIONS', 'NODE_PATH', 'MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_PROVIDERS',
  'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_SCRIPT_SHELL', 'HTTP_PROXY', 'GUGO_CODEX_SIGNATURE_MODULE',
]

// Only this synthetic harness runs in PowerShell. Every command that could
// install packages, launch the application, access HTTP or stop a process is
// replaced before invoking the real verification script.
const fixtureScript = String.raw`
param([string]$VerificationScript, [string]$ArchivePath, [string]$FixtureRoot, [string]$Scenario, [string]$Version)
$ErrorActionPreference = 'Stop'
$global:WebVerificationFixture = @{
  Calls = [System.Collections.Generic.List[object]]::new()
  Scenario = $Scenario
  Version = $Version
  RunnerRoot = (Join-Path $FixtureRoot 'runner')
  VerificationRoot = $null
  CollisionPath = $null
  StoppedIds = [System.Collections.Generic.List[int]]::new()
  WaitCount = 0
}
function Record-FixtureCommand([string]$Name, [object[]]$Arguments) {
  $values = @{}
  foreach ($key in @(
    'APP_DATA_DIR', 'APP_DB_PATH', 'APP_CONFIG_PATH', 'ARTIFACT_DIR', 'WORKSPACE_ROOT',
    'TEMP', 'TMP', 'TMPDIR', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_DEVDIR',
    'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG',
    'GUGO_LOAD_DOTENV', 'GUGO_PURE_LOCAL_MODE', 'CODEX_PLUGIN_ROOTS',
    'CODEX_APP_SERVER_ENABLED', 'MCP_STDIO_ENABLED', 'SERVER_HOST', 'SERVER_PORT', 'NODE_ENV',
    'GUGO_TURN_PERSISTENCE_MODULE', 'GUGO_TURN_PERSISTENCE_TRUST_ROOT',
    'NODE_OPTIONS', 'NODE_PATH', 'MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_PROVIDERS',
    'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_SCRIPT_SHELL', 'HTTP_PROXY', 'GUGO_CODEX_SIGNATURE_MODULE'
  )) {
    $values[$key] = [System.Environment]::GetEnvironmentVariable($key, 'Process')
  }
  $global:WebVerificationFixture.Calls.Add(@{
    Name = $Name; Arguments = @($Arguments); Environment = $values; Cwd = (Get-Location).Path
  })
}
function Test-Path {
  [CmdletBinding()]
  param([string]$LiteralPath, [string]$PathType)
  $state = $global:WebVerificationFixture
  if ($state.Scenario -eq 'collision' -and -not $state.CollisionPath -and
      (Split-Path -Parent $LiteralPath) -eq $state.RunnerRoot -and
      (Split-Path -Leaf $LiteralPath) -match '^gugo-web-release-.+-[a-f0-9]{32}$') {
    [System.IO.Directory]::CreateDirectory($LiteralPath) | Out-Null
    $state.CollisionPath = Join-Path $LiteralPath 'keep.txt'
    [System.IO.File]::WriteAllText($state.CollisionPath, 'existing directory must survive')
    $state.VerificationRoot = $LiteralPath
  }
  Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function tar {
  Record-FixtureCommand 'tar' $args
  $state = $global:WebVerificationFixture
  $state.VerificationRoot = [string]$args[3]
  if ($state.Scenario -eq 'tar-failure') { $global:LASTEXITCODE = 2; return }
  $packageRoot = Join-Path $state.VerificationRoot "gugo-$($state.Version)-web"
  foreach ($entry in @(
    'dist/index.html', 'server/start.js', 'package-lock.json', 'THIRD_PARTY_NOTICES.md',
    'bin/yma-cli.js', 'docs/CLI.md', 'resources/licenses/LGPL-3.0.txt'
  )) {
    if ($state.Scenario -eq 'missing-file' -and $entry -eq 'dist/index.html') { continue }
    $target = Join-Path $packageRoot $entry
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    [System.IO.File]::WriteAllText($target, 'throw new Error("Synthetic release: never execute");')
  }
  $global:LASTEXITCODE = 0
}
function npm {
  Record-FixtureCommand 'npm' $args
  $global:LASTEXITCODE = if ($global:WebVerificationFixture.Scenario -eq 'npm-failure') { 3 } else { 0 }
}
function node {
  Record-FixtureCommand 'node' $args
  $global:LASTEXITCODE = 0
  if ($args[0] -ne 'bin/yma-cli.js') { throw 'Unexpected node execution in fixture' }
  if ($args[1] -eq '--version') {
    if ($global:WebVerificationFixture.Scenario -eq 'cli-mismatch') { return '0.0.0' }
    return $global:WebVerificationFixture.Version
  }
  if ($args[1] -eq '--help') { return 'Usage: gugo run [options]' }
  throw 'Unexpected CLI arguments in fixture'
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $RedirectStandardOutput, $RedirectStandardError,
    [switch]$PassThru, $WindowStyle)
  Record-FixtureCommand 'Start-Process' @($FilePath, $ArgumentList, $WindowStyle)
  $child = [pscustomobject]@{
    Id = 2147483647
    HasExited = ($global:WebVerificationFixture.Scenario -eq 'server-exited')
    ExitCode = 19
  }
  $child | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
    $global:WebVerificationFixture.WaitCount += 1
  }
  return $child
}
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  Record-FixtureCommand 'Invoke-WebRequest' @($Uri)
  return @{ StatusCode = 200 }
}
function Stop-Process {
  param([int]$Id, [switch]$Force)
  Record-FixtureCommand 'Stop-Process' @($Id)
  $global:WebVerificationFixture.StoppedIds.Add($Id)
  if ($global:WebVerificationFixture.Scenario -eq 'stop-failure') {
    [System.Environment]::SetEnvironmentVariable('VERIFICATION_FIXTURE_CHILD_VALUE', 'remove on restore', 'Process')
    throw 'Synthetic child stop failed'
  }
}
$beforeEnvironment = [System.Environment]::GetEnvironmentVariables('Process')
$beforeLocation = (Get-Location).Path
$caughtError = $null
try { & $VerificationScript -ArchivePath $ArchivePath }
catch { $caughtError = $_.Exception.Message }
$afterEnvironment = [System.Environment]::GetEnvironmentVariables('Process')
$restored = $beforeEnvironment.Count -eq $afterEnvironment.Count
foreach ($entry in $beforeEnvironment.GetEnumerator()) {
  if (-not $afterEnvironment.Contains($entry.Key) -or $afterEnvironment[$entry.Key] -cne $entry.Value) {
    $restored = $false
  }
}
$state = $global:WebVerificationFixture
$result = @{
  Error = $caughtError
  EnvironmentRestored = $restored
  LocationRestored = (Get-Location).Path -eq $beforeLocation
  VerificationRoot = $state.VerificationRoot
  Calls = @($state.Calls.ToArray())
  StoppedIds = @($state.StoppedIds.ToArray())
  WaitCount = $state.WaitCount
  CollisionContent = if ($state.CollisionPath -and [System.IO.File]::Exists($state.CollisionPath)) {
    [System.IO.File]::ReadAllText($state.CollisionPath)
  } else { $null }
}
Write-Output ('VERIFICATION_FIXTURE_RESULT:' + ($result | ConvertTo-Json -Compress -Depth 8))
`

function runFixture(t, scenario) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, 'gugo-web-verification-fixture-'))
  t.after(() => {
    assert.equal(path.dirname(fixtureRoot), temporaryRoot)
    assert.match(path.basename(fixtureRoot), /^gugo-web-verification-fixture-/)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })
  const fixturePath = path.join(fixtureRoot, 'fixture.ps1')
  const archivePath = path.join(fixtureRoot, 'mock.tar.gz')
  const runnerRoot = path.join(fixtureRoot, 'runner')
  const hostSentinel = path.join(fixtureRoot, 'host-data-sentinel.txt')
  fs.mkdirSync(runnerRoot)
  fs.writeFileSync(fixturePath, fixtureScript)
  fs.writeFileSync(archivePath, 'Synthetic archive: extraction must be mocked')
  fs.writeFileSync(hostSentinel, 'host data must remain unchanged')
  const env = {
    ...nativeEnvironment,
    RUNNER_TEMP: runnerRoot,
    ...Object.fromEntries(isolatedPathKeys.map((key) => [key, hostSentinel])),
    ...Object.fromEntries(blockedEnvironmentKeys.map((key) => [key, 'synthetic-host-injection'])),
    GUGO_LOAD_DOTENV: '1', GUGO_PURE_LOCAL_MODE: '0', CODEX_PLUGIN_ROOTS: hostSentinel,
    CODEX_APP_SERVER_ENABLED: '1', MCP_STDIO_ENABLED: '1',
    SERVER_HOST: '192.0.2.10', SERVER_PORT: '1234', NODE_ENV: 'development',
  }
  const child = spawnSync(powerShell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixturePath,
    '-VerificationScript', verificationScript, '-ArchivePath', archivePath,
    '-FixtureRoot', fixtureRoot, '-Scenario', scenario, '-Version', version,
  ], { cwd: fixtureRoot, env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout)
  const output = child.stdout.split(/\r?\n/).find((line) => line.startsWith('VERIFICATION_FIXTURE_RESULT:'))
  assert.ok(output, child.stdout || child.stderr)
  const result = JSON.parse(output.slice('VERIFICATION_FIXTURE_RESULT:'.length))
  assert.equal(result.EnvironmentRestored, true, 'all original values and absent variables must be restored')
  assert.equal(result.LocationRestored, true, 'the caller working directory must be restored')
  assert.equal(fs.readFileSync(hostSentinel, 'utf8'), 'host data must remain unchanged')
  assert.equal(path.dirname(result.VerificationRoot), runnerRoot)
  for (const call of result.Calls) {
    for (const key of isolatedPathKeys) {
      const relative = path.relative(result.VerificationRoot, call.Environment[key] || '')
      assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
        `${call.Name}: ${key} must stay inside this verification run`)
    }
    for (const key of blockedEnvironmentKeys) assert.equal(call.Environment[key], null, `${call.Name}: ${key}`)
    for (const [key, value] of Object.entries({
      GUGO_LOAD_DOTENV: '0', GUGO_PURE_LOCAL_MODE: '1', CODEX_PLUGIN_ROOTS: '[]',
      CODEX_APP_SERVER_ENABLED: '0', MCP_STDIO_ENABLED: '0', SERVER_HOST: '127.0.0.1', NODE_ENV: 'production',
    })) assert.equal(call.Environment[key], value, `${call.Name}: ${key}`)
    assert.ok(Number(call.Environment.SERVER_PORT) > 0)
  }
  return result
}

const powerShellOptions = { skip: powerShell ? false : 'PowerShell is required for the Web verification harness' }

test('Web release verification isolates every command and restores the caller on success', powerShellOptions, (t) => {
  const result = runFixture(t, 'success')
  assert.equal(result.Error, null)
  assert.deepEqual(result.Calls.map((call) => call.Name), [
    'tar', 'npm', 'node', 'node', 'Start-Process', 'Invoke-WebRequest', 'Stop-Process',
  ])
  assert.deepEqual(result.StoppedIds, [2147483647])
  assert.equal(result.WaitCount, 1)
  const start = result.Calls.find((call) => call.Name === 'Start-Process')
  assert.deepEqual(start.Arguments, ['node', 'server/start.js', 'Hidden'])
  assert.equal(path.basename(start.Cwd), `gugo-${version}-web`)
})

for (const [scenario, expectedError, expectedCalls] of [
  ['tar-failure', /archive extraction failed/, ['tar']],
  ['missing-file', /does not contain dist\/index.html/, ['tar']],
  ['npm-failure', /Production dependency installation failed/, ['tar', 'npm']],
  ['cli-mismatch', /CLI reported version/, ['tar', 'npm', 'node']],
  ['collision', /already exists; refusing to reuse/, []],
]) {
  test(`Web release verification restores state and never launches the server after ${scenario}`, powerShellOptions, (t) => {
    const result = runFixture(t, scenario)
    assert.match(result.Error, expectedError)
    assert.deepEqual(result.Calls.map((call) => call.Name), expectedCalls)
    assert.deepEqual(result.StoppedIds, [])
    if (scenario === 'collision') assert.equal(result.CollisionContent, 'existing directory must survive')
  })
}

test('Web release verification restores state after its server has already exited', powerShellOptions, (t) => {
  const result = runFixture(t, 'server-exited')
  assert.match(result.Error, /server exited with code 19/)
  assert.deepEqual(result.StoppedIds, [])
  assert.equal(result.WaitCount, 1)
})

test('Web release verification restores state even when stopping its own child fails', powerShellOptions, (t) => {
  const result = runFixture(t, 'stop-failure')
  assert.match(result.Error, /Synthetic child stop failed/)
  assert.deepEqual(result.StoppedIds, [2147483647])
})

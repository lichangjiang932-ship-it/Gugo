import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertReleaseSigningInputs, readReleasePolicy, releasePolicyNotes, validateReleasePolicy } from '../scripts/release/releasePolicy.mjs'
import { unsignedWindowsBuildArgs, unsignedWindowsBuildEnvironment } from '../scripts/release/package-unsigned-windows.mjs'
import { verifyInstallerSignature } from '../desktop/updateSignature.js'
import { readUpdaterPublishers } from '../scripts/release/read-updater-publishers.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policy = (windowsSigning = 'unsigned', version = '1.2.3') => ({ schemaVersion: 1, version, windowsSigning })
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-release-policy-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('release signing policy is explicit, closed-schema, immutable, and version-bound', () => {
  for (const mode of ['signed', 'unsigned']) {
    const validated = validateReleasePolicy(policy(mode), '1.2.3')
    assert.deepEqual(validated, policy(mode))
    assert.equal(Object.isFrozen(validated), true)
  }
  for (const invalid of [
    null, [], {}, { schemaVersion: 1, version: '1.2.3' },
    ...['', 'auto', 'Unsigned', false, null].map((mode) => policy(mode)),
    { ...policy(), schemaVersion: 2 }, { ...policy(), version: '1.2.4' },
    { ...policy(), allowUnsignedFallback: true },
  ]) assert.throws(() => validateReleasePolicy(invalid, '1.2.3'), /explicitly declare.*exact package version/u)
  assert.throws(() => validateReleasePolicy(policy(), ''), /exact package version/u)
  assert.throws(() => validateReleasePolicy(policy('unsigned', 'invalid'), 'invalid'), /exact package version/u)
})

test('policy loading refuses a missing decision or package-version drift instead of defaulting unsigned', (t) => {
  const rootDir = temporaryDirectory(t)
  fs.mkdirSync(path.join(rootDir, 'scripts', 'release'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  assert.throws(() => readReleasePolicy(rootDir), /ENOENT/u)
  const policyPath = path.join(rootDir, 'scripts', 'release', 'policy.json')
  fs.writeFileSync(policyPath, JSON.stringify(policy('unsigned', '1.2.4')))
  assert.throws(() => readReleasePolicy(rootDir), /exact package version/u)
  fs.writeFileSync(policyPath, JSON.stringify(policy('signed')))
  assert.deepEqual(readReleasePolicy(rootDir), policy('signed'))
  assert.equal(readReleasePolicy().version, JSON.parse(read('package.json')).version)
})

test('signed releases require every signing input and cannot use an environment unsigned fallback', () => {
  const inputs = { CSC_LINK: 'test.pfx', CSC_KEY_PASSWORD: 'test', WINDOWS_PUBLISHER_NAME: 'Fixture Publisher' }
  assert.doesNotThrow(() => assertReleaseSigningInputs(policy('signed'), inputs))
  for (const key of Object.keys(inputs)) {
    for (const empty of [undefined, '', '   ']) {
      assert.throws(() => assertReleaseSigningInputs(policy('signed'), {
        ...inputs, [key]: empty, WINDOWS_SIGNING_MODE: 'unsigned', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      }), /required.*automatic unsigned fallback is forbidden/u)
    }
  }
  assert.doesNotThrow(() => assertReleaseSigningInputs(policy('unsigned'), {}))
  assert.throws(() => assertReleaseSigningInputs({ ...policy(), windowsSigning: 'auto' }, inputs), /explicitly declare/u)
})

test('unsigned packaging uses a detached child environment with all certificate and publisher aliases removed', () => {
  const source = {
    CSC_LINK: 'test.pfx', CSC_KEY_PASSWORD: 'test', CSC_NAME: 'test', CSC_IDENTITY_AUTO_DISCOVERY: 'true',
    WIN_CSC_LINK: 'test.pfx', WIN_CSC_KEY_PASSWORD: 'test', WIN_CSC_NAME: 'test',
    WINDOWS_CSC_LINK: 'test.pfx', WINDOWS_CSC_KEY_PASSWORD: 'test', WINDOWS_CSC_NAME: 'test',
    WINDOWS_PUBLISHER_NAME: 'Fixture Publisher', csc_link: 'test.pfx', Win_Csc_Key_Password: 'test',
    windows_publisher_name: 'Fixture Publisher', NODE_ENV: 'production', GUGO_RETAINED: 'fixture',
  }
  const before = structuredClone(source)
  const child = unsignedWindowsBuildEnvironment(source)
  assert.notEqual(child, source)
  assert.deepEqual(source, before)
  assert.deepEqual(child, { NODE_ENV: 'production', GUGO_RETAINED: 'fixture', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  const args = unsignedWindowsBuildArgs('test output (not built)')
  assert.equal(args[args.indexOf('--publish') + 1], 'never')
  assert.equal(args[args.indexOf('--config') + 1], path.join(ROOT, 'scripts/release/electron-builder-unsigned.cjs'))
  assert.ok(args.includes(`--config.directories.output=${path.resolve('test output (not built)')}`))
  assert.match(read('scripts/release/package-unsigned-windows.mjs'), /windowsHide:\s*true/u)
})

test('the unsigned override passes the installed electron-builder schema and retains resource editing and updater verification', async () => {
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
  const configPath = path.join(ROOT, 'scripts/release/electron-builder-unsigned.cjs')
  const config = await getConfig(ROOT, configPath, null)
  const debugLogger = { isEnabled: false, add: () => {} }
  await validateConfiguration(config, debugLogger)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.win.signExecutable, false)
  assert.equal(config.win.signtoolOptions.publisherName, null)
  assert.notEqual(config.win.signAndEditExecutable, false)
  assert.notEqual(config.win.verifyUpdateCodeSignature, false)
  assert.equal(config.win.icon, 'build/icon.ico')
  assert.equal(config.win.executableName, 'Gugo')
  assert.doesNotMatch(read('electron-builder.yml'), /(?:forceCodeSigning|signAndEditExecutable|verifyUpdateCodeSignature)\s*:\s*false/u)
  const invalid = structuredClone(config)
  invalid.win.publisherName = null
  await assert.rejects(() => validateConfiguration(invalid, debugLogger), /publisherName|schema/iu)
})

test('unsigned release selection never globally disables an installed signed client signature verifier', async () => {
  let calls = 0
  await assert.rejects(() => verifyInstallerSignature({
    verifySignature: async () => { calls += 1; return 'Fixture signer mismatch' },
  }, 'fixture.exe'), (error) => error.code === 'UPDATE_SIGNATURE_INVALID')
  assert.equal(calls, 1)
  await assert.rejects(() => verifyInstallerSignature({}, 'fixture.exe'), (error) => error.code === 'UPDATE_SIGNATURE_VERIFIER_UNAVAILABLE')
  assert.doesNotMatch(read('desktop/updateSetup.js'), /verifyUpdateCodeSignature\s*=\s*false/u)
})

test('release notes disclose unsigned identity and manual migration without equating hashes to certificates', () => {
  const unsigned = releasePolicyNotes(policy())
  assert.match(unsigned, /unsigned[\s\S]*未签名/u)
  assert.match(unsigned, /unknown-publisher|SmartScreen/u)
  assert.match(unsigned, /Do not disable Windows protections/u)
  assert.match(unsigned, /do not substitute for a signing certificate/u)
  assert.match(unsigned, /user-initiated manual migration/u)
  assert.match(releasePolicyNotes(policy('signed')), /valid timestamped Authenticode/u)
  assert.throws(() => releasePolicyNotes({ ...policy(), windowsSigning: 'auto' }), /explicitly declare/u)
})

test('updater metadata uses actual typed publisher values and rejects malformed or oversized YAML', (t) => {
  const directory = temporaryDirectory(t)
  const filePath = path.join(directory, 'app-update.yml')
  for (const [source, expected] of [
    ['provider: github\n', []], ['publisherName: null\n', []],
    ['publisherName: Fixture Publisher\n', ['Fixture Publisher']],
    ['publisherName:\n  - Fixture Publisher\n', ['Fixture Publisher']],
    ['publisherName: [One, Two]\n', ['One', 'Two']],
    ['# publisherName: Fiction\nprovider: github\n', []],
    ['publisherName: Other Publisher\n# Fixture Publisher\n', ['Other Publisher']],
  ]) {
    fs.writeFileSync(filePath, source)
    assert.deepEqual(readUpdaterPublishers(filePath), expected)
  }
  for (const source of [
    '', 'null', '[]', 'publisherName: [unterminated',
    'publisherName: First\npublisherName: Second\n',
    'publisherName: true', 'publisherName: 123', 'publisherName: { value: Wrong }',
    'publisherName: []', 'publisherName: [Fixture, null]', 'publisherName: "   "',
    `publisherName: "${'x'.repeat(501)}"`,
    JSON.stringify({ publisherName: Array.from({ length: 17 }, () => 'Fixture') }),
    `#${'x'.repeat(64 * 1024)}\npublisherName: Fixture Publisher\n`,
  ]) {
    fs.writeFileSync(filePath, source)
    assert.throws(() => readUpdaterPublishers(filePath))
  }
  assert.throws(() => readUpdaterPublishers(directory), /Invalid updater metadata file/u)
})

function resolvePowerShell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh']
  for (const command of candidates) {
    const probe = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    })
    if (!probe.error && probe.status === 0) return command
  }
  return null
}

const POWERSHELL = resolvePowerShell()
const POWERSHELL_HARNESS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cases = $env:GUGO_RELEASE_VERIFY_CASES | ConvertFrom-Json
$results = @()
function Get-AuthenticodeSignature {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $global:GugoSigningSeen.Add([IO.Path]::GetFileName($LiteralPath))
  $entry = if ([IO.Path]::GetFileName($LiteralPath) -eq 'Gugo.exe') { $global:GugoSigningCurrent.app } else { $global:GugoSigningCurrent.installer }
  $certificate = $null
  if ($entry.signer) {
    $certificate = [pscustomobject]@{ Thumbprint = $entry.thumbprint; FixtureName = $entry.publisher }
    $certificate | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value {
      param($NameType, $ForIssuer)
      return $this.FixtureName
    }
  }
  $timestamp = if ($entry.timestamp) { [pscustomobject]@{ Subject = 'Fixture timestamp' } } else { $null }
  [pscustomobject]@{ Status = $entry.status; SignerCertificate = $certificate; TimeStamperCertificate = $timestamp }
}
foreach ($item in $cases) {
  $global:GugoSigningCurrent = $item
  $global:GugoSigningSeen = New-Object 'System.Collections.Generic.List[string]'
  $env:WINDOWS_PUBLISHER_NAME = $item.publisher
  $arguments = @{ ReleaseDirectory = $item.directory; Version = $item.version }
  if (-not $item.omitMode) { $arguments.Mode = $item.mode }
  try {
    $verification = @(& $env:GUGO_RELEASE_VERIFY_SCRIPT @arguments)
    $results += [pscustomobject]@{ name = $item.name; ok = $true; calls = @($global:GugoSigningSeen.ToArray()); output = ($verification -join [Environment]::NewLine); error = $null }
  } catch {
    $results += [pscustomobject]@{ name = $item.name; ok = $false; calls = @($global:GugoSigningSeen.ToArray()); error = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @($results) -Depth 8 -Compress
`

function signature(overrides = {}) {
  return { status: 'Valid', signer: true, timestamp: true, thumbprint: 'AB'.repeat(20), publisher: 'Fixture Publisher', ...overrides }
}

function verifyScenarios(t, scenarios) {
  const rootDir = temporaryDirectory(t)
  const cases = scenarios.map((scenario, index) => {
    const directory = path.join(rootDir, `case-${index}`)
    const resourceDir = path.join(directory, 'win-unpacked', 'resources')
    fs.mkdirSync(resourceDir, { recursive: true })
    const installerName = scenario.installerName || 'Gugo-Setup-1.2.3-x64.exe'
    fs.writeFileSync(path.join(directory, installerName), Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(path.join(directory, 'win-unpacked', 'Gugo.exe'), Buffer.from([0, 1, 2, 3]))
    if (scenario.extraInstaller) fs.writeFileSync(path.join(directory, scenario.extraInstaller), 'fixture')
    if (!scenario.missingMetadata) fs.writeFileSync(path.join(resourceDir, 'app-update.yml'), scenario.metadata ?? (scenario.mode === 'unsigned' ? 'provider: github\n' : 'publisherName:\n  - Fixture Publisher\n'))
    const unsigned = signature({ status: 'NotSigned', signer: false, timestamp: false })
    return {
      name: scenario.name, directory, mode: scenario.mode ?? 'signed', version: scenario.version ?? '1.2.3',
      omitMode: scenario.omitMode === true, publisher: scenario.publisher ?? 'Fixture Publisher',
      installer: scenario.installer || (scenario.mode === 'unsigned' ? unsigned : signature()),
      app: scenario.app || (scenario.mode === 'unsigned' ? unsigned : signature()),
    }
  })
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(POWERSHELL_HARNESS, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...unsignedWindowsBuildEnvironment(process.env), GUGO_RELEASE_VERIFY_CASES: JSON.stringify(cases), GUGO_RELEASE_VERIFY_SCRIPT: path.join(ROOT, 'scripts/release/verify-windows-signing.ps1') },
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  const decoded = JSON.parse(result.stdout.replace(/^\uFEFF/u, '').trim())
  assert.equal(decoded.length, scenarios.length)
  return decoded
}

test('PowerShell unsigned verification checks both files and rejects corrupt or pretend signatures and publisher claims', { skip: !POWERSHELL && 'PowerShell is required for the Windows signing verifier' }, (t) => {
  const scenarios = [
    { name: 'clean unsigned pair', mode: 'unsigned' },
    { name: 'corrupt installer', mode: 'unsigned', installer: signature({ status: 'HashMismatch' }) },
    { name: 'corrupt application', mode: 'unsigned', app: signature({ status: 'HashMismatch' }) },
    { name: 'pretend unsigned signer', mode: 'unsigned', app: signature({ status: 'NotSigned' }) },
    { name: 'unexpected valid signature', mode: 'unsigned', installer: signature() },
    { name: 'publisher scalar advertised', mode: 'unsigned', metadata: 'publisherName: Fixture Publisher\n' },
    { name: 'publisher list advertised', mode: 'unsigned', metadata: 'publisherName:\n  - Fixture Publisher\n' },
  ]
  const results = verifyScenarios(t, scenarios)
  assert.equal(results[0].ok, true, results[0].error)
  assert.deepEqual(results[0].calls, ['Gugo-Setup-1.2.3-x64.exe', 'Gugo.exe'])
  assert.match(results[0].output, /Verified unsigned/u)
  for (const result of results.slice(1)) assert.equal(result.ok, false, result.name)
  assert.deepEqual(results[2].calls, ['Gugo-Setup-1.2.3-x64.exe', 'Gugo.exe'])
})

test('PowerShell signed verification retains signer, timestamp, matching-certificate and exact publisher requirements', { skip: !POWERSHELL && 'PowerShell is required for the Windows signing verifier' }, (t) => {
  const scenarios = [
    { name: 'valid signed pair' },
    { name: 'missing signer', installer: signature({ signer: false }) },
    { name: 'installer hash mismatch', installer: signature({ status: 'HashMismatch' }) },
    { name: 'application hash mismatch', app: signature({ status: 'HashMismatch' }) },
    { name: 'missing installer timestamp', installer: signature({ timestamp: false }) },
    { name: 'missing app timestamp', app: signature({ timestamp: false }) },
    { name: 'different app certificate', app: signature({ thumbprint: 'CD'.repeat(20) }) },
    { name: 'empty publisher setting', publisher: '' },
    { name: 'wrong publisher setting', publisher: 'Other Publisher' },
    { name: 'wrong publisher casing', publisher: 'fixture publisher' },
    { name: 'missing publisher metadata', metadata: 'provider: github\n' },
    { name: 'multiple advertised publishers', metadata: 'publisherName: [Fixture Publisher, Other Publisher]\n' },
  ]
  const results = verifyScenarios(t, scenarios)
  assert.equal(results[0].ok, true, results[0].error)
  assert.deepEqual(results[0].calls, ['Gugo-Setup-1.2.3-x64.exe', 'Gugo.exe'])
  assert.match(results[0].output, /Verified signed/u)
  for (const result of results.slice(1)) assert.equal(result.ok, false, result.name)
})

test('PowerShell verifies the publisher field itself rather than unrelated comments or substring matches', { skip: !POWERSHELL && 'PowerShell is required for the Windows signing verifier' }, (t) => {
  const results = verifyScenarios(t, [
    { name: 'wrong publisher with signer in comment', metadata: 'publisherName: Other Publisher\n# Fixture Publisher\n' },
    { name: 'wrong publisher with signer elsewhere', metadata: 'publisherName:\n  - Other Publisher\nreleaseNotes: Fixture Publisher\n' },
    { name: 'publisher prefix collision', metadata: 'publisherName: Fixture Publisher Extra\n' },
  ])
  for (const result of results) assert.equal(result.ok, false, result.name)
})

test('PowerShell refuses missing or invalid mode and non-exact installer layout before signature inspection', { skip: !POWERSHELL && 'PowerShell is required for the Windows signing verifier' }, (t) => {
  const results = verifyScenarios(t, [
    { name: 'no mode', omitMode: true }, { name: 'automatic mode forbidden', mode: 'auto' },
    { name: 'invalid version', mode: 'unsigned', version: 'invalid' },
    { name: 'installer version drift', mode: 'unsigned', version: '1.2.4' },
    { name: 'wrong architecture', mode: 'unsigned', installerName: 'Gugo-Setup-1.2.3-arm64.exe' },
    { name: 'extra installer', mode: 'unsigned', extraInstaller: 'Gugo-Setup-1.2.2-x64.exe' },
    { name: 'missing updater metadata', mode: 'unsigned', missingMetadata: true },
  ])
  for (const result of results) { assert.equal(result.ok, false, result.name); assert.deepEqual(result.calls, [], result.name) }
})

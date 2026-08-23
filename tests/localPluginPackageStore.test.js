import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LOCAL_PLUGIN_PACKAGE_TRANSACTION_DIRNAME,
  installLocalPluginPackage,
  listInstalledLocalPluginPackages,
  recoverLocalPluginPackageTransactions,
  uninstallLocalPluginPackage,
  verifyInstalledLocalPluginPackage,
} from '../server/plugins/localPluginPackageStore.js'
import {
  LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE,
} from '../server/plugins/localPluginPackageSnapshot.js'

const LOCAL_PLUGIN_PACKAGE_STORE_MODULE_URL = new URL(
  '../server/plugins/localPluginPackageStore.js',
  import.meta.url,
).href

const COMPETITION_WORKER_SOURCE = String.raw`
import fs from 'node:fs'

const payload = JSON.parse(process.env.GUGO_LOCAL_PLUGIN_WORKER_PAYLOAD)
fs.writeFileSync(payload.readyPath, 'ready\n')
while (!fs.existsSync(payload.goPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const { installLocalPluginPackage } = await import(payload.moduleUrl)
let result
try {
  const installed = await installLocalPluginPackage({
    sourceDir: payload.sourceDir,
    managedRoot: payload.managedRoot,
    expectedRevision: payload.expectedRevision,
  })
  result = {
    ok: true,
    operation: installed.operation,
    packageDigest: installed.package.packageDigest,
  }
} catch (error) {
  result = {
    ok: false,
    code: String(error?.code || 'PLUGIN_PACKAGE_WORKER_FAILED'),
    message: String(error?.message || error),
  }
}
process.stdout.write(JSON.stringify(result))
`

function createFixture(t, name) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `gugo-plugin-store-${name}-`))
  const managedRoot = path.join(fixtureRoot, 'managed')
  const sourcesRoot = path.join(fixtureRoot, 'sources')
  fs.mkdirSync(managedRoot, { recursive: true })
  fs.mkdirSync(sourcesRoot, { recursive: true })
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  return { fixtureRoot, managedRoot, sourcesRoot }
}

function writePluginPackage(sourcesRoot, {
  directory,
  id = 'package-test',
  version = '1.0.0',
  source = 'export default (input) => input\n',
} = {}) {
  const sourceDir = path.join(sourcesRoot, directory || version)
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'plugin.json'), JSON.stringify({
    id,
    name: 'Package test',
    version,
    type: 'transformer',
    entry: 'index.js',
  }))
  fs.writeFileSync(path.join(sourceDir, 'index.js'), source)
  return sourceDir
}

function errorCode(code) {
  return (error) => {
    assert.equal(error?.code, code)
    return true
  }
}

function transactionRootFor(managedRoot) {
  return path.join(path.dirname(managedRoot), LOCAL_PLUGIN_PACKAGE_TRANSACTION_DIRNAME)
}

function createCrashedUninstallTransaction({ managedRoot, packageDigest, committed }) {
  const pluginId = 'package-test'
  const transactionId = randomUUID()
  const transactionDir = path.join(transactionRootFor(managedRoot), `tx-${transactionId}`)
  const backupPlugin = path.join(transactionDir, 'backup', pluginId)
  fs.mkdirSync(path.dirname(backupPlugin), { recursive: true })
  fs.renameSync(path.join(managedRoot, pluginId), backupPlugin)
  fs.writeFileSync(path.join(transactionDir, 'transaction.json'), `${JSON.stringify({
    schemaVersion: 1,
    transactionId,
    operation: 'uninstall',
    pluginId,
    hadExisting: true,
    packageDigest: null,
    previousPackageDigest: packageDigest,
  })}\n`)
  if (committed) fs.writeFileSync(path.join(transactionDir, 'committed'), 'committed\n')
  return transactionDir
}

function createCrashedUpgradeTransaction({
  managedRoot,
  previousPackageDir,
  previousPackageDigest,
  packageDigest,
  committed,
}) {
  const pluginId = 'package-test'
  const transactionId = randomUUID()
  const transactionDir = path.join(transactionRootFor(managedRoot), `tx-${transactionId}`)
  const backupPlugin = path.join(transactionDir, 'backup', pluginId)
  fs.mkdirSync(path.dirname(backupPlugin), { recursive: true })
  fs.cpSync(previousPackageDir, backupPlugin, { recursive: true })
  fs.writeFileSync(path.join(transactionDir, 'transaction.json'), `${JSON.stringify({
    schemaVersion: 1,
    transactionId,
    operation: 'install',
    pluginId,
    hadExisting: true,
    packageDigest,
    previousPackageDigest,
  })}\n`)
  if (committed) fs.writeFileSync(path.join(transactionDir, 'committed'), 'committed\n')
  return transactionDir
}

async function prepareInstalledUpgrade(t, name) {
  const fixture = createFixture(t, name)
  const v1Source = writePluginPackage(fixture.sourcesRoot, {
    directory: 'v1',
    version: '1.0.0',
  })
  const v2Source = writePluginPackage(fixture.sourcesRoot, {
    directory: 'v2',
    version: '2.0.0',
    source: 'export default (input) => ({ upgraded: true, input })\n',
  })
  const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  const installed = await installLocalPluginPackage({
    sourceDir: v1Source,
    managedRoot: fixture.managedRoot,
    expectedRevision: empty.revision,
  })
  const previousPackageDir = path.join(fixture.fixtureRoot, 'previous', 'package-test')
  fs.mkdirSync(path.dirname(previousPackageDir), { recursive: true })
  fs.cpSync(path.join(fixture.managedRoot, 'package-test'), previousPackageDir, { recursive: true })
  const upgraded = await installLocalPluginPackage({
    sourceDir: v2Source,
    managedRoot: fixture.managedRoot,
    expectedRevision: installed.store.revision,
    replace: true,
  })
  return { ...fixture, installed, upgraded, previousPackageDir }
}

function waitForFiles(paths, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const check = () => {
      if (paths.every((filePath) => fs.existsSync(filePath))) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for worker barriers: ${paths.join(', ')}`))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

function spawnCompetitionWorker(payload) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    COMPETITION_WORKER_SOURCE,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GUGO_LOCAL_PLUGIN_WORKER_PAYLOAD: JSON.stringify({
        ...payload,
        moduleUrl: LOCAL_PLUGIN_PACKAGE_STORE_MODULE_URL,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const result = new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('plugin package competition worker timed out'))
    }, 15_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`plugin package competition worker failed (${code ?? signal}): ${stderr || stdout}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (cause) {
        reject(new Error(`plugin package competition worker returned invalid JSON: ${stdout || stderr}`, { cause }))
      }
    })
  })
  return { child, result }
}

test('local plugin package store installs, upgrades, enforces CAS, and uninstalls', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'lifecycle')
  const v1 = writePluginPackage(sourcesRoot, { directory: 'v1', version: '1.0.0' })
  const v2 = writePluginPackage(sourcesRoot, {
    directory: 'v2',
    version: '2.0.0',
    source: 'export default (input) => ({ version: 2, input })\n',
  })

  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  assert.equal(empty.schemaVersion, 1)
  assert.match(empty.revision, /^sha256-[a-f0-9]{64}$/)
  assert.deepEqual(empty.packages, [])

  const installed = await installLocalPluginPackage({
    sourceDir: v1,
    managedRoot,
    expectedRevision: empty.revision,
    expectedPluginId: 'package-test',
    now: () => 1_000,
  })
  assert.equal(installed.changed, true)
  assert.equal(installed.operation, 'installed')
  assert.equal(installed.package.pluginId, 'package-test')
  assert.equal(installed.package.pluginVersion, '1.0.0')
  assert.notEqual(installed.store.revision, empty.revision)
  assert.equal(installed.cleanupDeferred, false)

  await assert.rejects(
    installLocalPluginPackage({
      sourceDir: v2,
      managedRoot,
      expectedRevision: empty.revision,
      replace: true,
    }),
    errorCode('PLUGIN_PACKAGE_REVISION_CONFLICT'),
  )

  await assert.rejects(
    installLocalPluginPackage({
      sourceDir: v2,
      managedRoot,
      expectedRevision: installed.store.revision,
    }),
    errorCode('PLUGIN_PACKAGE_ALREADY_INSTALLED'),
  )

  const upgraded = await installLocalPluginPackage({
    sourceDir: v2,
    managedRoot,
    expectedRevision: installed.store.revision,
    replace: true,
    now: () => 2_000,
  })
  assert.equal(upgraded.changed, true)
  assert.equal(upgraded.operation, 'upgraded')
  assert.equal(upgraded.package.pluginVersion, '2.0.0')
  assert.notEqual(upgraded.package.packageDigest, installed.package.packageDigest)
  assert.notEqual(upgraded.store.revision, installed.store.revision)
  assert.equal(
    verifyInstalledLocalPluginPackage(path.join(managedRoot, 'package-test')).packageDigest,
    upgraded.package.packageDigest,
  )

  const uninstalled = await uninstallLocalPluginPackage({
    pluginId: 'package-test',
    managedRoot,
    expectedRevision: upgraded.store.revision,
  })
  assert.equal(uninstalled.changed, true)
  assert.equal(uninstalled.operation, 'uninstalled')
  assert.deepEqual(uninstalled.store.packages, [])
  assert.equal(fs.existsSync(path.join(managedRoot, 'package-test')), false)

  const finalStore = await listInstalledLocalPluginPackages({ managedRoot })
  assert.deepEqual(finalStore.packages, [])
})

test('installed package content tampering is rejected by its receipt', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'content-tamper')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  await installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
  })

  const packageDir = path.join(managedRoot, 'package-test')
  fs.appendFileSync(path.join(packageDir, 'index.js'), '// tampered\n')

  assert.throws(
    () => verifyInstalledLocalPluginPackage(packageDir),
    errorCode('PLUGIN_PACKAGE_CONTENT_MISMATCH'),
  )
  await assert.rejects(
    listInstalledLocalPluginPackages({ managedRoot }),
    errorCode('PLUGIN_PACKAGE_CONTENT_MISMATCH'),
  )
})

test('adding an empty directory invalidates an installed package receipt', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'empty-directory-tamper')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  await installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
  })

  const packageDir = path.join(managedRoot, 'package-test')
  fs.mkdirSync(path.join(packageDir, 'tampered-empty-directory'))

  assert.throws(
    () => verifyInstalledLocalPluginPackage(packageDir),
    errorCode('PLUGIN_PACKAGE_CONTENT_MISMATCH'),
  )
})

test('deleting a packaged empty directory invalidates an installed package receipt', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'empty-directory-delete')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const packagedEmptyDirectory = path.join(sourceDir, 'required-empty-directory')
  fs.mkdirSync(packagedEmptyDirectory)
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  await installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
  })

  const installedEmptyDirectory = path.join(
    managedRoot,
    'package-test',
    'required-empty-directory',
  )
  assert.equal(
    fs.existsSync(installedEmptyDirectory),
    true,
    'empty directories declared by the package must survive installation',
  )
  fs.rmdirSync(installedEmptyDirectory)

  assert.throws(
    () => verifyInstalledLocalPluginPackage(path.join(managedRoot, 'package-test')),
    errorCode('PLUGIN_PACKAGE_CONTENT_MISMATCH'),
  )
})

test('installed package receipt tampering is rejected', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'receipt-tamper')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  await installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
  })

  const packageDir = path.join(managedRoot, 'package-test')
  const receiptPath = path.join(packageDir, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE)
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.packageDigest = `sha256-${'0'.repeat(64)}`
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`)

  assert.throws(
    () => verifyInstalledLocalPluginPackage(packageDir),
    errorCode('PLUGIN_PACKAGE_CONTENT_MISMATCH'),
  )
})

test('plugin package source links and junctions are rejected', async (t) => {
  const { fixtureRoot, managedRoot, sourcesRoot } = createFixture(t, 'source-link')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const linkedSource = path.join(fixtureRoot, 'linked-source')
  try {
    fs.symlinkSync(sourceDir, linkedSource, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`this host cannot create a directory link: ${error.code}`)
      return
    }
    throw error
  }

  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  await assert.rejects(
    installLocalPluginPackage({
      sourceDir: linkedSource,
      managedRoot,
      expectedRevision: empty.revision,
    }),
    errorCode('PLUGIN_PACKAGE_LINK_FORBIDDEN'),
  )
})

test('crash recovery rolls back an uncommitted uninstall journal', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'recover-uncommitted')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  const installed = await installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
  })
  const transactionDir = createCrashedUninstallTransaction({
    managedRoot,
    packageDigest: installed.package.packageDigest,
    committed: false,
  })
  assert.equal(fs.existsSync(path.join(managedRoot, 'package-test')), false)
  assert.equal(fs.existsSync(transactionDir), true)

  assert.equal(await recoverLocalPluginPackageTransactions({ managedRoot }), true)
  assert.equal(fs.existsSync(transactionDir), false)
  assert.equal(
    verifyInstalledLocalPluginPackage(path.join(managedRoot, 'package-test')).packageDigest,
    installed.package.packageDigest,
  )
  const recovered = await listInstalledLocalPluginPackages({ managedRoot })
  assert.equal(recovered.packages.length, 1)
  assert.equal(recovered.packages[0].packageDigest, installed.package.packageDigest)
})

test('crash recovery preserves a committed uninstall and removes its journal', async (t) => {
  const { managedRoot, sourcesRoot } = createFixture(t, 'recover-committed')
  const sourceDir = writePluginPackage(sourcesRoot, {})
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  const installed = await installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
  })
  const transactionDir = createCrashedUninstallTransaction({
    managedRoot,
    packageDigest: installed.package.packageDigest,
    committed: true,
  })

  assert.equal(await recoverLocalPluginPackageTransactions({ managedRoot }), true)
  assert.equal(fs.existsSync(transactionDir), false)
  assert.equal(fs.existsSync(path.join(managedRoot, 'package-test')), false)
  assert.deepEqual((await listInstalledLocalPluginPackages({ managedRoot })).packages, [])
})

test('crash recovery rolls back an uncommitted upgrade to the verified previous package', async (t) => {
  const {
    managedRoot,
    installed,
    upgraded,
    previousPackageDir,
  } = await prepareInstalledUpgrade(t, 'recover-upgrade-uncommitted')
  const transactionDir = createCrashedUpgradeTransaction({
    managedRoot,
    previousPackageDir,
    previousPackageDigest: installed.package.packageDigest,
    packageDigest: upgraded.package.packageDigest,
    committed: false,
  })

  assert.equal(await recoverLocalPluginPackageTransactions({ managedRoot }), true)
  assert.equal(fs.existsSync(transactionDir), false)
  const receipt = verifyInstalledLocalPluginPackage(path.join(managedRoot, 'package-test'))
  assert.equal(receipt.pluginVersion, '1.0.0')
  assert.equal(receipt.packageDigest, installed.package.packageDigest)
})

test('crash recovery preserves a committed upgrade and removes its verified backup', async (t) => {
  const {
    managedRoot,
    installed,
    upgraded,
    previousPackageDir,
  } = await prepareInstalledUpgrade(t, 'recover-upgrade-committed')
  const transactionDir = createCrashedUpgradeTransaction({
    managedRoot,
    previousPackageDir,
    previousPackageDigest: installed.package.packageDigest,
    packageDigest: upgraded.package.packageDigest,
    committed: true,
  })

  assert.equal(await recoverLocalPluginPackageTransactions({ managedRoot }), true)
  assert.equal(fs.existsSync(transactionDir), false)
  const receipt = verifyInstalledLocalPluginPackage(path.join(managedRoot, 'package-test'))
  assert.equal(receipt.pluginVersion, '2.0.0')
  assert.equal(receipt.packageDigest, upgraded.package.packageDigest)
})

test('two processes competing on one revision produce one complete install', async (t) => {
  const { fixtureRoot, managedRoot, sourcesRoot } = createFixture(t, 'process-race')
  const sourceDir = writePluginPackage(sourcesRoot, {
    source: 'export default (input) => ({ raced: true, input })\n',
  })
  const empty = await listInstalledLocalPluginPackages({ managedRoot })
  const goPath = path.join(fixtureRoot, 'go')
  const readyPaths = [
    path.join(fixtureRoot, 'worker-a.ready'),
    path.join(fixtureRoot, 'worker-b.ready'),
  ]
  const workers = readyPaths.map((readyPath) => spawnCompetitionWorker({
    sourceDir,
    managedRoot,
    expectedRevision: empty.revision,
    readyPath,
    goPath,
  }))
  t.after(() => {
    for (const worker of workers) {
      if (worker.child.exitCode === null) worker.child.kill('SIGKILL')
    }
  })

  await waitForFiles(readyPaths)
  fs.writeFileSync(goPath, 'go\n')
  const results = await Promise.all(workers.map((worker) => worker.result))
  const successes = results.filter((result) => result.ok)
  const failures = results.filter((result) => !result.ok)
  assert.equal(successes.length, 1, JSON.stringify(results))
  assert.equal(successes[0].operation, 'installed')
  assert.equal(failures.length, 1, JSON.stringify(results))
  assert.ok(
    ['PLUGIN_PACKAGE_STORE_BUSY', 'PLUGIN_PACKAGE_REVISION_CONFLICT'].includes(failures[0].code),
    JSON.stringify(results),
  )

  const finalStore = await listInstalledLocalPluginPackages({ managedRoot })
  assert.equal(finalStore.packages.length, 1)
  assert.equal(finalStore.packages[0].pluginId, 'package-test')
  assert.equal(finalStore.packages[0].packageDigest, successes[0].packageDigest)
  assert.equal(
    verifyInstalledLocalPluginPackage(path.join(managedRoot, 'package-test')).packageDigest,
    successes[0].packageDigest,
  )
  const transactionRoot = transactionRootFor(managedRoot)
  assert.deepEqual(
    fs.readdirSync(transactionRoot).filter((entry) => entry.startsWith('tx-')),
    [],
  )
  assert.equal(fs.existsSync(path.join(transactionRoot, 'store.lock')), false)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createChecksumManifest } from '../scripts/release/create-checksums.mjs'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

test('release checksum manifest is deterministic and uses downloadable basenames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-release-checksums-'))
  try {
    fs.mkdirSync(path.join(root, 'release'))
    const desktopBytes = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const browserBytes = Buffer.from('浏览器', 'utf8')
    fs.writeFileSync(path.join(root, 'release', 'β-Gugo-Setup.exe'), desktopBytes)
    fs.writeFileSync(path.join(root, 'Å-gugo-web.tar.gz'), browserBytes)

    const result = await createChecksumManifest({
      cwd: root,
      files: ['release/β-Gugo-Setup.exe', 'Å-gugo-web.tar.gz'],
      outputPath: 'SHA256SUMS.txt',
    })

    assert.deepEqual(result.entries, [
      { name: 'Å-gugo-web.tar.gz', sha256: sha256(browserBytes), size: browserBytes.length },
      { name: 'β-Gugo-Setup.exe', sha256: sha256(desktopBytes), size: desktopBytes.length },
    ])
    assert.equal(fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8'), [
      `${sha256(browserBytes)}  Å-gugo-web.tar.gz`,
      `${sha256(desktopBytes)}  β-Gugo-Setup.exe`,
      '',
    ].join('\n'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release checksum manifest rejects ambiguous or non-file inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-release-checksum-guard-'))
  try {
    fs.mkdirSync(path.join(root, 'one'))
    fs.mkdirSync(path.join(root, 'two'))
    fs.writeFileSync(path.join(root, 'one', 'Same.exe'), 'one')
    fs.writeFileSync(path.join(root, 'two', 'same.EXE'), 'two')
    fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), 'old')

    await assert.rejects(
      createChecksumManifest({ cwd: root, files: ['one/Same.exe', 'two/same.EXE'] }),
      /duplicate release filename/,
    )
    await assert.rejects(
      createChecksumManifest({ cwd: root, files: ['one'] }),
      /must be a regular file/,
    )
    await assert.rejects(
      createChecksumManifest({ cwd: root, files: ['SHA256SUMS.txt'] }),
      /cannot hash itself/,
    )
    await assert.rejects(
      createChecksumManifest({ cwd: root, files: ['missing.exe'] }),
      /ENOENT/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release workflow fails closed on signing and publishes checksums with provenance', () => {
  const workflow = read('.github/workflows/release.yml')
  const packageJson = JSON.parse(read('package.json'))
  const packageLock = JSON.parse(read('package-lock.json'))
  const requireSigning = workflow.indexOf('Require Windows code-signing credentials')
  const packageDesktop = workflow.indexOf('Package Windows desktop installer')
  const verifySignature = workflow.indexOf('Verify Windows installer signature')
  const createChecksums = workflow.indexOf('Create release checksum manifest')
  const attest = workflow.indexOf('Attest release build provenance')
  const publish = workflow.indexOf('Create or update GitHub Release')

  assert.match(workflow, /WINDOWS_CSC_LINK/)
  assert.match(workflow, /WINDOWS_CSC_KEY_PASSWORD/)
  assert.match(workflow, /WINDOWS_PUBLISHER_NAME:\s*\$\{\{ vars\.WINDOWS_PUBLISHER_NAME \}\}/)
  assert.match(workflow, /IsNullOrWhiteSpace\(\$env:CSC_LINK\)/)
  assert.match(workflow, /IsNullOrWhiteSpace\(\$env:CSC_KEY_PASSWORD\)/)
  assert.match(workflow, /IsNullOrWhiteSpace\(\$env:WINDOWS_PUBLISHER_NAME\)/)
  assert.match(workflow, /concurrency:\s*[\s\S]*group:\s*release-/)
  assert.match(workflow, /cancel-in-progress:\s*false/)
  assert.match(workflow, /fetch-depth:\s*0/)
  assert.match(workflow, /refs\/heads\/main:refs\/remotes\/origin\/main/)
  assert.match(workflow, /git merge-base --is-ancestor \$headCommit refs\/remotes\/origin\/main/)
  assert.match(workflow, /Get-AuthenticodeSignature/)
  assert.match(workflow, /\.Status -ne 'Valid'/)
  assert.match(workflow, /TimeStamperCertificate/)
  assert.match(workflow, /release\/win-unpacked\/Gugo\.exe/)
  assert.match(workflow, /release\/win-unpacked\/resources\/app-update\.yml/)
  assert.match(workflow, /publisherName/)
  assert.match(workflow, /SignerCertificate\.Thumbprint/)
  assert.match(workflow, /\$signerName -cne \$env:WINDOWS_PUBLISHER_NAME/)
  assert.match(workflow, /package-lock\.json versions/)
  assert.match(workflow, /create-checksums\.mjs --output SHA256SUMS\.txt/)
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.match(workflow, /actions\/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a/)
  assert.match(workflow, /attestations:\s*write/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /subject-path:[\s\S]*SHA256SUMS\.txt/)
  assert.match(workflow, /\$checksumAsset = \(Resolve-Path 'SHA256SUMS\.txt'\)\.Path/)
  assert.equal(packageLock.version, packageJson.version)
  assert.equal(packageLock.packages[''].version, packageJson.version)
  assert.match(packageJson.scripts['desktop:package:signed'], /forceCodeSigning=true/)
  assert.match(packageJson.scripts['desktop:publish'], /block-direct-desktop-publish\.mjs/)
  assert.match(workflow, /npm run desktop:package:signed/)
  assert.ok(requireSigning >= 0 && requireSigning < packageDesktop)
  assert.ok(packageDesktop < verifySignature)
  assert.ok(verifySignature < createChecksums)
  assert.ok(createChecksums < attest)
  assert.ok(attest < publish)
})

test('direct desktop publishing is blocked in favor of the attested tag workflow', () => {
  const blocker = fileURLToPath(
    new URL('../scripts/release/block-direct-desktop-publish.mjs', import.meta.url),
  )
  const result = spawnSync(process.execPath, [blocker], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Direct desktop publishing is disabled/)
  assert.match(result.stderr, /code-signature verification, checksums, provenance/)
})

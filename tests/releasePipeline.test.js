import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { stageWebRelease, WEB_RELEASE_ENTRIES } from '../scripts/release/package-web.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8')

function createReleaseFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-release-fixture-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const directories = new Set(['dist', 'server', 'shared', 'seed', 'plugins', 'resources/licenses'])
  for (const entry of WEB_RELEASE_ENTRIES) {
    const target = path.join(rootDir, entry)
    if (directories.has(entry)) {
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, '.release-fixture'), entry)
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry)
    }
  }
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'gugo', version: '1.2.3' }))
  fs.writeFileSync(path.join(rootDir, 'dist', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(rootDir, 'server', 'start.js'), '')
  fs.writeFileSync(path.join(rootDir, 'resources', 'licenses', 'LGPL-3.0.txt'), 'LGPL fixture')
  return rootDir
}

test('Web release staging contains a complete runnable distribution and is repeatable', (t) => {
  const rootDir = createReleaseFixture(t)
  const outputDir = path.join(rootDir, 'output')
  const first = stageWebRelease({ rootDir, outputDir })

  assert.equal(first.packageDirectoryName, 'gugo-1.2.3-web')
  for (const entry of WEB_RELEASE_ENTRIES) {
    assert.equal(fs.existsSync(path.join(first.stageDir, entry)), true, `missing ${entry}`)
  }
  assert.match(readFrom(first.stageDir, 'README-WEB.md'), /npm ci --omit=dev/)
  assert.match(readFrom(first.stageDir, 'README-WEB.md'), /npm run serve/)
  assert.equal(fs.existsSync(path.join(first.stageDir, 'resources', 'licenses', 'LGPL-3.0.txt')), true)

  fs.writeFileSync(path.join(first.stageDir, 'stale.txt'), 'stale')
  const second = stageWebRelease({ rootDir, outputDir })
  assert.equal(fs.existsSync(path.join(second.stageDir, 'stale.txt')), false)
})

test('Web release staging refuses a build without dist/index.html', (t) => {
  const rootDir = createReleaseFixture(t)
  fs.rmSync(path.join(rootDir, 'dist', 'index.html'))
  assert.throws(
    () => stageWebRelease({ rootDir, outputDir: path.join(rootDir, 'output') }),
    /dist\/index\.html/,
  )
})

test('Release workflow is gated by reusable CI and reruns update existing releases', () => {
  const ci = read('.github/workflows/ci.yml')
  const release = read('.github/workflows/release.yml')
  assert.match(ci, /workflow_call:/)
  assert.match(ci, /checkout_ref:/)
  assert.match(ci, /npm run test:coverage/)
  assert.match(ci, /npm run audit:prod/)
  assert.match(ci, /gitleaks\/gitleaks-action/)
  assert.match(ci, /docker build --tag gugo:ci/)
  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /needs:\s*ci/)
  assert.match(release, /npm run desktop:check/)
  assert.match(release, /scripts\/release\/package-web\.mjs/)
  assert.match(release, /scripts\/release\/verify-web-release\.ps1/)
  assert.match(release, /gh release view/)
  assert.match(release, /gh release upload[^\n]*--clobber/)
  assert.match(release, /gh release create/)
  const verification = read('scripts/release/verify-web-release.ps1')
  assert.match(verification, /THIRD_PARTY_NOTICES\.md/)
  assert.match(verification, /resources\/licenses\/LGPL-3\.0\.txt/)
  assert.match(verification, /RedirectStandardOutput/)
  assert.match(verification, /RedirectStandardError/)
  assert.match(verification, /Read-ServerDiagnostics/)
})

test('Web release includes the server parser dependency closure without browser barrels', () => {
  const runtimeParserEntries = [
    'src/lib/officeExport/documentExport.js',
    'src/lib/officeExport/officeCommon.js',
    'src/lib/officeExport/spreadsheetExport.js',
    'src/lib/presentationExport/presentationParseHelpers.js',
    'src/lib/presentationExport/presentationParser.js',
  ]
  for (const entry of runtimeParserEntries) {
    assert.equal(WEB_RELEASE_ENTRIES.includes(entry), true, `missing runtime parser dependency ${entry}`)
  }

  const heuristics = read('server/services/loop/heuristics/artifactPublishing.js')
  assert.match(heuristics, /officeExport\/documentExport\.js/)
  assert.match(heuristics, /officeExport\/spreadsheetExport\.js/)
  assert.match(heuristics, /presentationExport\/presentationParser\.js/)
  assert.doesNotMatch(heuristics, /from ['"]\.\.\/\.\.\/src\/lib\/(?:officeExport|presentationExport)\.js['"]/)
})

function readFrom(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

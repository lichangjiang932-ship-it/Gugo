import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  const directories = new Set(['bin', 'dist', 'server', 'shared', 'seed', 'plugins', 'resources/licenses'])
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
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
    name: 'gugo',
    version: '1.2.3',
    type: 'module',
    bin: { gugo: './bin/yma-cli.js' },
  }))
  fs.writeFileSync(path.join(rootDir, 'bin', 'yma-cli.js'), `#!/usr/bin/env node
import fs from 'node:fs'
const metadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (process.argv.includes('--version')) process.stdout.write(\`\${metadata.version}\\n\`)
else if (process.argv.includes('--help')) process.stdout.write('Usage: gugo fixture\\n  gugo run\\n')
else process.exitCode = 2
`)
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
  assert.match(readFrom(first.stageDir, 'README-WEB.md'), /node bin\/yma-cli\.js --version/)
  assert.match(readFrom(first.stageDir, 'README-WEB.md'), /node bin\/yma-cli\.js --help/)
  assert.equal(fs.existsSync(path.join(first.stageDir, 'bin', 'yma-cli.js')), true)
  assert.equal(fs.existsSync(path.join(first.stageDir, 'docs', 'CLI.md')), true)
  assert.equal(execFileSync(process.execPath, [path.join(first.stageDir, 'bin', 'yma-cli.js'), '--version'], {
    encoding: 'utf8',
  }).trim(), '1.2.3')
  assert.match(execFileSync(process.execPath, [path.join(first.stageDir, 'bin', 'yma-cli.js'), '--help'], {
    encoding: 'utf8',
  }), /^Usage:.*gugo run/ms)
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

test('Release workflow is gated by reusable CI and never overwrites a published release', () => {
  const ci = read('.github/workflows/ci.yml')
  const release = read('.github/workflows/release.yml')
  const publisher = read('scripts/release/publish-github-release.mjs')
  const releaseDocs = read('docs/DESKTOP_RELEASES.md')
  const packageMetadata = JSON.parse(read('package.json'))
  const offlineGate = ci.match(
    /- name: Offline agent capability gate[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] || ''
  assert.match(ci, /workflow_call:/)
  assert.match(ci, /checkout_ref:/)
  assert.match(offlineGate, /run:\s*npm run eval:offline\s*$/m)
  assert.doesNotMatch(offlineGate, /--eval-suite/)
  assert.equal(packageMetadata.scripts['eval:offline'], 'node scripts/run-tests.js offline-eval')
  assert.match(ci, /npm run test:coverage/)
  assert.match(ci, /npm run audit:prod/)
  assert.match(ci, /gitleaks\/gitleaks-action/)
  assert.match(ci, /docker build --tag gugo:ci/)
  assert.match(release, /Windows differential update blockmap was not generated/)
  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /needs:\s*ci/)
  assert.match(release, /npm run desktop:check/)
  assert.match(release, /scripts\/release\/package-web\.mjs/)
  assert.match(release, /scripts\/release\/verify-web-release\.ps1/)
  assert.match(release, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/)
  assert.match(release, /node scripts\/release\/publish-github-release\.mjs/)
  assert.match(release, /--commit \$releaseCommit/)
  assert.doesNotMatch(release, /\bgh(?:\.exe)?\s+release\b/)
  assert.doesNotMatch(releaseDocs, /\bgh(?:\.exe)?\s+release\b/)
  assert.match(publisher, /generate_release_notes:\s*true/)
  assert.match(publisher, /git\/ref\/tags\/\$\{encodeURIComponent\(tag\)\}/)
  assert.match(publisher, /target_commitish:\s*commit/)
  assert.match(publisher, /Published GitHub Release[^\n]*already exists and is immutable/)
  assert.match(publisher, /releases\/assets\/\$\{asset\.id\}/)
  assert.match(publisher, /uploadsBaseUrl[^\n]*\/assets\?name=/)
  assert.match(publisher, /Draft GitHub Release contains unexpected assets/)
  assert.ok(
    publisher.indexOf('verifyRemoteAssets(uploadedAssets, assets)')
      < publisher.indexOf('await publishDraft('),
    'remote asset verification must complete before the draft is published',
  )
  const verification = read('scripts/release/verify-web-release.ps1')
  assert.match(verification, /THIRD_PARTY_NOTICES\.md/)
  assert.match(verification, /bin\/yma-cli\.js/)
  assert.match(verification, /docs\/CLI\.md/)
  assert.match(verification, /'--version'/)
  assert.match(verification, /'--help'/)
  assert.match(verification, /CLI reported version/)
  assert.match(verification, /CLI --help output is incomplete/)
  assert.match(verification, /resources\/licenses\/LGPL-3\.0\.txt/)
  assert.match(verification, /RedirectStandardOutput/)
  assert.match(verification, /RedirectStandardError/)
  assert.match(verification, /Read-ServerDiagnostics/)
})

test('Release full offline gate cannot omit compaction fidelity', () => {
  const release = read('.github/workflows/release.yml')
  const ci = read('.github/workflows/ci.yml')
  const runner = read('scripts/run-tests.js')
  const fullGate = read('tests/offlineCapabilityEval.test.js')
  const suite = read('tests/offline-evals/compactionFidelity.eval.js')
  const offlineGate = ci.match(
    /- name: Offline agent capability gate[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] || ''

  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /needs:\s*ci/)
  assert.match(offlineGate, /run:\s*npm run eval:offline\s*$/m)
  assert.doesNotMatch(offlineGate, /--eval-suite/)
  assert.match(
    runner,
    /selector === 'offline-eval'\) return \['tests\/offlineCapabilityEval\.test\.js'\]/,
  )
  assert.match(fullGate, /REQUIRED_FULL_GATE_SUITE_IDS[\s\S]*?'compaction-fidelity'/)
  assert.match(suite, /id:\s*'compaction-fidelity'/)
})

test('CI workflow pins checkout and Node setup actions to immutable commits', () => {
  const ci = read('.github/workflows/ci.yml')
  const checkoutRefs = [...ci.matchAll(/actions\/checkout@([^\s#]+)/g)].map((match) => match[1])
  const setupNodeRefs = [...ci.matchAll(/actions\/setup-node@([^\s#]+)/g)].map((match) => match[1])

  assert.ok(checkoutRefs.length > 0, 'CI must use actions/checkout')
  assert.ok(setupNodeRefs.length > 0, 'CI must use actions/setup-node')
  assert.deepEqual(new Set(checkoutRefs), new Set(['11d5960a326750d5838078e36cf38b85af677262']))
  assert.deepEqual(new Set(setupNodeRefs), new Set(['49933ea5288caeca8642d1e84afbd3f7d6820020']))
  assert.doesNotMatch(ci, /actions\/(?:checkout|setup-node)@v4\b/)
})

test('CI keeps required Node 22 tests cross-platform and gates Node 20 and 24 runtimes', () => {
  const ci = read('.github/workflows/ci.yml')
  const release = read('.github/workflows/release.yml')
  const testJob = ci.match(/^ {2}test:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\r?$)/m)?.[0] || ''
  const compatibilityJob = ci.match(
    /^ {2}node-runtime-compatibility:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\r?$)/m,
  )?.[0] || ''
  const coverageJob = ci.match(
    /^ {2}coverage:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\r?$)/m,
  )?.[0] || ''

  assert.match(testJob, /name:\s*test \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node-version \}\}\)/)
  assert.match(testJob, /os:\s*\[ubuntu-latest, windows-latest\]/)
  assert.match(testJob, /node-version:\s*\[22\.x\]/)
  assert.match(
    testJob,
    /TEST_CONCURRENCY:\s*\$\{\{ runner\.os == 'Windows' && '1' \|\| '4' \}\}/,
  )
  assert.match(testJob, /run:\s*npm test/)
  assert.match(compatibilityJob, /runs-on:\s*ubuntu-latest/)
  assert.match(compatibilityJob, /node-version:\s*\[20\.19\.x, 24\.x\]/)
  assert.match(compatibilityJob, /node-version:\s*\$\{\{ matrix\.node-version \}\}/)
  assert.match(
    compatibilityJob,
    /run:\s*node --test --test-concurrency=1 tests\/dbMigrationRegistry\.test\.js tests\/runtimeReadiness\.test\.js/,
  )
  assert.match(compatibilityJob, /run:\s*npm run lint/)
  assert.match(compatibilityJob, /run:\s*npm run build/)
  assert.match(coverageJob, /TEST_CONCURRENCY:\s*1/)
  assert.match(coverageJob, /run:\s*npm run test:coverage/)
  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /node-version:\s*22\.x/)
})

test('scheduled debt check is read-only, lightweight, and manually runnable', () => {
  const workflow = read('.github/workflows/debt-check.yml')
  const packageMetadata = JSON.parse(read('package.json'))

  assert.match(workflow, /schedule:\s*\r?\n\s+- cron:\s*'[^']+'/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/)
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(workflow, /persist-credentials:\s*false/)
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.match(workflow, /node-version:\s*22\.x/)
  assert.match(workflow, /run:\s*npm run debt:check/)
  assert.doesNotMatch(workflow, /npm (?:ci|install)/)
  assert.equal(packageMetadata.scripts['debt:check'], 'node --test tests/codeDebt.test.js')
})

test('Release secret scanning cannot pass without scanning an explicit checkout ref', () => {
  const ci = read('.github/workflows/ci.yml')
  const ignoreEntries = read('.gitleaksignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  assert.match(ci, /if:\s*\$\{\{ inputs\.checkout_ref == '' \}\}[\s\S]*gitleaks\/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7/)
  assert.match(ci, /name: Install pinned Gitleaks for explicit ref scan[\s\S]*if:\s*\$\{\{ inputs\.checkout_ref != '' \}\}/)
  assert.match(ci, /GITLEAKS_VERSION:\s*'8\.24\.3'/)
  assert.match(ci, /GITLEAKS_ARCHIVE_SHA256:\s*9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c/)
  assert.match(ci, /name: Scan explicit release ref history with Gitleaks[\s\S]*target_sha="\$\(git rev-parse HEAD\)"[\s\S]*--log-opts="\$target_sha"/)

  const expectedFalsePositives = [
    'bc4b8a250e3b24d584ccfaa28f29070d011afc7d:tests/runtimeReadiness.test.js:generic-api-key:86',
    'bc4b8a250e3b24d584ccfaa28f29070d011afc7d:tests/evolutionOperations.test.js:generic-api-key:1322',
    'bc4b8a250e3b24d584ccfaa28f29070d011afc7d:tests/shellSession.test.js:generic-api-key:351',
  ]
  for (const fingerprint of expectedFalsePositives) {
    assert.equal(ignoreEntries.includes(fingerprint), true, `missing exact Gitleaks fingerprint ${fingerprint}`)
  }
  for (const entry of ignoreEntries) {
    assert.match(entry, /^[0-9a-f]{40}:[^:]+:[^:]+:\d+$/, `Gitleaks ignore must remain fingerprint-only: ${entry}`)
  }
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

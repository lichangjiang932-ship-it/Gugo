import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const historicalHashes = Object.freeze({
  V1: 'e407b37a30228afe96c3fc2ec4c05c710f00640709fac0f122b00ec833523295',
  V2: 'd9542735bc22dca2ce627d07e1764499d5cc81572a4795bccc4ac85af0bec566',
  V3: '5c313b0224fcda3f5f3015611d58b565e44feace4083c7eca95b817ade0c73ee',
})
const fixturePath = (version) => `tests/fixtures/pptxAuthoringPolicy${version}.txt`
const readRepositoryFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

function assertHistoricalBytes(content, version) {
  assert.equal(content.includes('\r'), false, `${version} must retain the issued host record's LF bytes`)
  assert.equal(createHash('sha256').update(content.trimEnd()).digest('hex'), historicalHashes[version])
}

test('historical presentation fixtures retain the exact issued host-policy hashes', () => {
  for (const version of Object.keys(historicalHashes)) {
    assertHistoricalBytes(readRepositoryFile(fixturePath(version)), version)
  }
})

test('a clean Git checkout preserves historical policy bytes even with core.autocrlf enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugo-policy-checkout-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = join(root, 'no-global-config')
  const git = (...args) => execFileSync('git', [
    '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false',
    '-c', `core.hooksPath=${join(root, 'no-hooks')}`, '-C', root, ...args,
  ], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: 'pipe' })
  try {
    git('init', '--quiet')
    mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true })
    writeFileSync(join(root, '.gitattributes'), readRepositoryFile('.gitattributes'))
    const names = Object.keys(historicalHashes).map(fixturePath)
    for (const name of names) writeFileSync(join(root, name), readRepositoryFile(name))
    git('add', '--', '.gitattributes', ...names)
    // Read a real recreated worktree, not git show/archive's canonical blob.
    for (const name of names) unlinkSync(join(root, name))
    git('checkout-index', '--all')
    for (const version of Object.keys(historicalHashes)) {
      assertHistoricalBytes(readFileSync(join(root, fixturePath(version)), 'utf8'), version)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

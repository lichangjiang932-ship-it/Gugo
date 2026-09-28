import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { assertReleaseSigningInputs, readReleasePolicy } from './releasePolicy.mjs'

/**
 * Publish this checkout as a desktop release, once the maintainer has said so.
 *
 * The tag-driven CI release stays the path that carries every guarantee — gates on
 * three platforms, signature verification, checksums, build provenance, immutable
 * assets. This script exists for the case that path cannot serve: publishing from
 * the machine that has the checkout, without waiting for a workflow, when the
 * maintainer decides to.
 *
 * It therefore does two things the CI path does not need to think about:
 * - it refuses unless it was asked to publish (no flag, no publication), and
 * - it runs the local gates itself, so "it passed here" means the same lens CI
 *   applies, minus what only a runner can do.
 *
 * What it cannot reproduce is printed before anything is uploaded: provenance
 * attestation needs the Actions runtime, the three-platform matrix needs the
 * runners, and the workflow's concurrency and immutability bookkeeping needs the
 * workflow. A release made here is a normal GitHub Release with the same five
 * assets and no attestation.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const GATES = [
  ['lint', ['run', 'lint']],
  ['typecheck', ['run', 'typecheck']],
  ['code debt', ['run', 'debt:check']],
  ['i18n keys', ['run', 'i18n:keys']],
  ['i18n tests', ['run', 'i18n:check']],
  ['dependency manifest', ['run', 'deps:check']],
  ['function audit', ['run', 'audit:functions', '--', '--check']],
  ['desktop checks', ['run', 'desktop:check']],
  ['build', ['run', 'build']],
  ['offline capability eval', ['run', 'eval:offline']],
  ['full test suite', ['run', 'test']],
]

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  return null
}

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    stdio: capture ? 'pipe' : 'inherit',
    shell: false,
  })
  if (capture) return { ok: result.status === 0, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() }
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
    error.exitStatus = result.status
    throw error
  }
  return { ok: true }
}

function git(args) {
  return run('git', args, { capture: true })
}

function resolveVersion() {
  const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const policy = readReleasePolicy(ROOT)
  assertReleaseSigningInputs(policy)
  return { policy, version: metadata.version, tag: `v${metadata.version}` }
}

/** Everything that must hold before a single byte is packaged. */
function preflight() {
  const problems = []
  if (process.platform !== 'win32') {
    problems.push('the desktop release targets Windows; this script refuses to publish one from another platform')
  }
  let release
  try {
    release = resolveVersion()
  } catch (error) {
    return { problems: [error?.message || String(error)], release: null }
  }
  const { policy, tag, version } = release

  const status = git(['status', '--porcelain'])
  if (!status.ok) problems.push('this checkout is not a git work tree')
  else if (status.stdout) {
    problems.push(`the working tree has uncommitted changes (${status.stdout.split('\n').length} paths); a release must be reproducible from a commit`)
  }

  const head = git(['rev-parse', 'HEAD'])
  const onRemote = git(['branch', '-r', '--contains', head.stdout])
  if (head.ok && onRemote.ok && !onRemote.stdout) {
    problems.push(`commit ${head.stdout.slice(0, 12)} is not on any origin branch; the published Release would point at a commit nobody else has`)
  }

  const tagged = git(['tag', '--points-at', 'HEAD'])
  if (tagged.ok && !tagged.stdout.split('\n').includes(tag)) {
    problems.push(`tag ${tag} is not on HEAD; the tag-driven CI release expects the tag to name the commit it releases`)
  }

  const versions = [
    ['package.json', version],
    ['scripts/release/policy.json', policy.version],
    ['shared/pluginCompatibility.js', fs.readFileSync(path.join(ROOT, 'shared/pluginCompatibility.js'), 'utf8').match(/PLUGIN_HOST_VERSION = '([^']+)'/)?.[1]],
  ]
  for (const [file, value] of versions) {
    if (value !== version) problems.push(`${file} says ${value}, expected ${version}`)
  }

  return { problems, release: { ...release, commit: head.stdout } }
}

function report({ problems, release }, { plan }) {
  const lines = []
  if (release) {
    lines.push(`Release ${release.version} (${release.tag}) from commit ${release.commit.slice(0, 12)}`)
    lines.push(`Signing policy: ${release.policy.windowsSigning}`)
  }
  lines.push('A release made here carries the same five assets as CI and no build provenance attestation,')
  lines.push('no three-platform gate matrix, and no workflow immutability bookkeeping, and it never runs by itself.')
  lines.push('')
  if (problems.length) {
    lines.push('This checkout is not ready to publish:')
    for (const problem of problems) lines.push(`  - ${problem}`)
  } else if (plan) {
    lines.push('Preflight passed. The steps below would run, in order:')
    for (const [label] of GATES) lines.push(`  - gate: ${label}`)
    lines.push('  - package: web bundle, then unsigned Windows installer')
    lines.push('  - verify: installer signing policy, then the checksum manifest')
    lines.push('  - publish: the GitHub Release through the repository REST publisher')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** The token the REST publisher needs, taken from the GitHub CLI login. */
function resolveToken() {
  if (String(process.env.GITHUB_TOKEN || '').trim()) return process.env.GITHUB_TOKEN.trim()
  const result = run('gh', ['auth', 'token'], { capture: true })
  if (result.ok && result.stdout) return result.stdout.split('\n')[0].trim()
  return null
}

function packageAndPublish({ commit, policy, tag, version }) {
  const releaseDir = path.join(ROOT, 'release')
  const installer = path.join(releaseDir, `Gugo-Setup-${version}-x64.exe`)

  run(NPM, ['run', 'desktop:media-sidecars'])
  // The web bundle is staged, archived and verified the way the workflow does it,
  // so the asset that lands here is the asset CI would have produced.
  const stagedWeb = path.join('.artifacts', 'web')
  run('node', ['scripts/release/package-web.mjs', '--output-dir', stagedWeb])
  const webPackage = `gugo-${version}-web`
  const webAsset = `${webPackage}.tar.gz`
  run('tar', ['-C', stagedWeb, '-czf', webAsset, webPackage])
  run('powershell', ['-NoProfile', '-File', 'scripts/release/verify-web-release.ps1', '-ArchivePath', webAsset])

  run('node', ['scripts/release/package-unsigned-windows.mjs'])
  if (!fs.existsSync(installer)) throw new Error(`the Windows installer was not produced at ${installer}`)

  run('powershell', ['-NoProfile', '-File', 'scripts/release/verify-windows-signing.ps1', '-Mode', policy.windowsSigning])

  const assets = [
    path.resolve(ROOT, webAsset),
    installer,
    `${installer}.blockmap`,
    path.join(releaseDir, 'latest.yml'),
  ]
  for (const asset of assets) {
    if (!fs.existsSync(asset)) throw new Error(`expected release asset is missing: ${asset}`)
  }
  run('node', ['scripts/release/create-checksums.mjs', '--output', 'SHA256SUMS.txt', ...assets])
  assets.push(path.join(ROOT, 'SHA256SUMS.txt'))

  const token = resolveToken()
  if (!token) throw new Error('no GitHub token: sign in with `gh auth login`, or set GITHUB_TOKEN')
  const repo = git(['remote', 'get-url', 'origin']).stdout.replace(/\.git$/, '').replace(/^.*github\.com[:/]/, '')
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`could not resolve the GitHub repository from origin (got "${repo}")`)

  run('node', [
    'scripts/release/publish-github-release.mjs',
    '--repo', repo,
    '--tag', tag,
    '--commit', commit,
    '--', ...assets,
  ], { env: { ...process.env, GITHUB_TOKEN: token } })
}

function main() {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => !['--plan', '--yes'].includes(arg))
  if (unknown.length) {
    fail(`Unknown option: ${unknown.join(' ')}\nUsage: node scripts/release/publish-desktop-authorized.mjs [--plan | --yes]`)
    return
  }
  const plan = args.includes('--plan')
  const authorized = args.includes('--yes')

  const preflightResult = preflight()
  report(preflightResult, { plan })
  if (!authorized && !plan) {
    // The headline requirement, printed whatever else is wrong with the checkout:
    // this script publishes when it is asked to, and otherwise not at all.
    process.stdout.write([
      'Publishing needs an explicit authorization: run this again with --yes once you mean it,',
      'or push a matching tag and let the attested CI release carry the guarantees above.',
    ].join(' ') + '\n')
  }

  if (preflightResult.problems.length) {
    fail('Nothing was packaged or published.')
    return
  }
  if (plan) {
    process.stdout.write('\nPlan only: nothing was packaged or published.\n')
    return
  }
  if (!authorized) {
    fail('Nothing was packaged or published.')
    return
  }

  process.stdout.write('\nAuthorized: running the gates before anything is packaged.\n')
  try {
    for (const [, npmArgs] of GATES) run(NPM, npmArgs)
    packageAndPublish(preflightResult.release)
  } catch (error) {
    fail(`\nPublication stopped: ${error?.message || error}`)
    return
  }
  process.stdout.write(`\nPublished ${preflightResult.release.tag}.\n`)
}

main()

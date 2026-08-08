import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')

export const AUDIT_EXCEPTIONS = Object.freeze({
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr': {
    dependency: 'image-size',
    dependencyVersion: '1.2.1',
    parent: 'pptxgenjs',
    parentVersion: '4.0.1',
    expiresOn: '2026-11-06',
  },
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq': {
    dependency: 'image-size',
    dependencyVersion: '1.2.1',
    parent: 'pptxgenjs',
    parentVersion: '4.0.1',
    expiresOn: '2026-11-06',
  },
})

function lockPackage(lock, name) {
  return lock?.packages?.[`node_modules/${name}`] || null
}

function exceptionProblem(advisory, exception, lock, now) {
  const dependency = lockPackage(lock, exception.dependency)
  const parent = lockPackage(lock, exception.parent)
  if (advisory.name !== exception.dependency) {
    return `advisory package changed from ${exception.dependency} to ${advisory.name}`
  }
  if (dependency?.version !== exception.dependencyVersion) {
    return `${exception.dependency} changed from ${exception.dependencyVersion} to ${dependency?.version || 'missing'}`
  }
  if (parent?.version !== exception.parentVersion) {
    return `${exception.parent} changed from ${exception.parentVersion} to ${parent?.version || 'missing'}`
  }
  if (!Object.hasOwn(parent?.dependencies || {}, exception.dependency)) {
    return `${exception.parent} no longer declares ${exception.dependency}`
  }
  const expiresAt = new Date(`${exception.expiresOn}T00:00:00.000Z`)
  if (!Number.isFinite(expiresAt.getTime()) || now >= expiresAt) {
    return `exception expired on ${exception.expiresOn}`
  }
  return ''
}

export function inspectProductionAudit(report, lock, now = new Date()) {
  const vulnerabilities = report?.vulnerabilities || {}
  const memo = new Map()
  const allowedAdvisories = new Set()

  function inspectPackage(name, stack = new Set()) {
    if (memo.has(name)) return memo.get(name)
    if (stack.has(name)) return [`${name}: cyclic vulnerability dependency`]
    const vulnerability = vulnerabilities[name]
    if (!vulnerability || !['high', 'critical'].includes(vulnerability.severity)) {
      memo.set(name, [])
      return []
    }

    const nextStack = new Set(stack).add(name)
    const problems = []
    for (const via of vulnerability.via || []) {
      if (typeof via === 'string') {
        problems.push(...inspectPackage(via, nextStack))
        continue
      }
      const exception = AUDIT_EXCEPTIONS[via?.url]
      if (!exception) {
        problems.push(`${name}: ${via?.url || via?.title || 'unidentified advisory'}`)
        continue
      }
      const problem = exceptionProblem(via, exception, lock, now)
      if (problem) problems.push(`${name}: ${via.url} (${problem})`)
      else allowedAdvisories.add(via.url)
    }
    if ((vulnerability.via || []).length === 0) {
      problems.push(`${name}: high-severity vulnerability has no advisory details`)
    }
    memo.set(name, problems)
    return problems
  }

  const problems = []
  for (const name of Object.keys(vulnerabilities)) {
    problems.push(...inspectPackage(name))
  }
  return {
    allowedAdvisories: [...allowedAdvisories].sort(),
    problems: [...new Set(problems)].sort(),
  }
}

function runAudit() {
  const npmCli = process.env.npm_execpath
  const command = npmCli ? process.execPath : 'npm'
  const args = npmCli
    ? [npmCli, 'audit', '--omit=dev', '--audit-level=high', '--json']
    : ['audit', '--omit=dev', '--audit-level=high', '--json']
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: !npmCli && process.platform === 'win32',
  })
  let report
  try {
    report = JSON.parse(result.stdout || '')
  } catch {
    const detail = String(result.stderr || result.stdout || 'npm audit returned no JSON').trim()
    throw new Error(`Production dependency audit could not run: ${detail}`)
  }
  if (report.error) {
    throw new Error(`Production dependency audit could not run: ${report.error.summary || report.error.message}`)
  }
  return report
}

function main() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const result = inspectProductionAudit(runAudit(), lock)
  if (result.problems.length > 0) {
    console.error('Production dependency audit failed:')
    for (const problem of result.problems) console.error(`- ${problem}`)
    process.exitCode = 1
    return
  }
  if (result.allowedAdvisories.length > 0) {
    console.warn('Production dependency audit passed with temporary, version-locked exceptions:')
    for (const url of result.allowedAdvisories) {
      console.warn(`- ${url} (expires ${AUDIT_EXCEPTIONS[url].expiresOn})`)
    }
    return
  }
  console.log('Production dependency audit passed with no high or critical vulnerabilities.')
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

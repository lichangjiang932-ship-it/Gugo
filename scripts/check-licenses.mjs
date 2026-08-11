import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const lockPath = path.join(root, 'package-lock.json')
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))

const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unicode-3.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
])

function normalizeExpression(value) {
  return String(value || '')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
}

function packageName(packagePath, metadata) {
  if (metadata?.name) return metadata.name
  return packagePath.replace(/^node_modules\//, '').replace(/\/node_modules\//g, ' > ')
}

const productionPackages = Object.entries(lock.packages || {})
  .filter(([packagePath, metadata]) => packagePath && !metadata?.dev)

const problems = []
const counts = new Map()

for (const [packagePath, metadata] of productionPackages) {
  const name = packageName(packagePath, metadata)
  const manifestPath = path.join(root, packagePath, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    if (metadata.optional) continue
    problems.push(`${name}: installed package manifest is missing; run npm ci`)
    continue
  }

  const expression = manifest.license || metadata.license
  const licenses = normalizeExpression(expression)
  if (licenses.length === 0) {
    problems.push(`${name}@${manifest.version || metadata.version}: license metadata is missing`)
    continue
  }
  const accepted = licenses.some((license) => allowedLicenses.has(license))
  if (!accepted) {
    problems.push(`${name}@${manifest.version || metadata.version}: license is not allowlisted (${expression})`)
  }
  counts.set(String(expression), (counts.get(String(expression)) || 0) + 1)
}

if (problems.length > 0) {
  console.error('Production dependency license check failed:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([license, count]) => `${license}: ${count}`)
    .join(', ')
  console.log(`License check passed for ${productionPackages.length} production packages (${summary}).`)
}

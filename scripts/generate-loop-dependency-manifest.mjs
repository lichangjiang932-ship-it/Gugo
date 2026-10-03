#!/usr/bin/env node
/**
 * Regenerate server/services/loop/dependencyBagManifest.js from the real loop
 * source. Uses acorn so destructuring aliases, defaults, nested patterns and
 * literal string index access are all counted. Rest elements and computed
 * (non-literal) access are reported as unresolved instead of being ignored.
 *
 *   node scripts/generate-loop-dependency-manifest.mjs [--check]
 *
 * `--check` fails when the committed manifest is stale.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'acorn'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOOP_ROOT = path.join(REPO_ROOT, 'server', 'services', 'loop')
const RUNTIME_FILE = path.join(LOOP_ROOT, 'runtime.js')
const MANIFEST_FILE = path.join(LOOP_ROOT, 'dependencyBagManifest.js')
const STATE_BAG_PROPERTY = 'd'

function walkJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return walkJavaScriptFiles(absolute)
      return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : []
    })
}

function walkAst(node, visitor) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visitor(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visitor)
    } else if (value && typeof value === 'object') {
      walkAst(value, visitor)
    }
  }
}

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  return null
}

function isBagMember(node) {
  return node?.type === 'MemberExpression'
    && !node.computed
    && node.property?.type === 'Identifier'
    && node.property.name === STATE_BAG_PROPERTY
    && node.object?.type === 'Identifier'
}

/** Collect consumed bag keys and any access the static scan cannot resolve. */
export function collectConsumedDependencies(source, file = '') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const consumed = new Set()
  const unresolved = []
  walkAst(ast, (node) => {
    // X.d.NAME
    if (node.type === 'MemberExpression' && !node.computed
      && node.object?.type === 'MemberExpression' && isBagMember(node.object)) {
      if (node.property?.type === 'Identifier') consumed.add(node.property.name)
      else unresolved.push({ file, reason: 'non-identifier property access on state bag' })
      return
    }
    // X.d['NAME'] / X.d["NAME"]
    if (node.type === 'MemberExpression' && node.computed && isBagMember(node)) {
      const name = staticString(node.property)
      if (name) consumed.add(name)
      else unresolved.push({ file, reason: 'computed state bag access with non-literal key' })
      return
    }
    // const { ... } = X.d
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && isBagMember(node.init)) {
      for (const property of node.id.properties) {
        if (property.type === 'RestElement') {
          unresolved.push({ file, reason: 'rest element in state bag destructuring' })
          continue
        }
        if (property.type !== 'Property') {
          unresolved.push({ file, reason: `unsupported destructuring node: ${property.type}` })
          continue
        }
        if (property.computed) {
          const name = staticString(property.key)
          if (name) consumed.add(name)
          else unresolved.push({ file, reason: 'computed key in state bag destructuring' })
          continue
        }
        if (property.key?.type === 'Identifier') consumed.add(property.key.name)
        else unresolved.push({ file, reason: 'unsupported destructuring key' })
      }
    }
  })
  return { consumed, unresolved }
}

export function declaredDependencies(source) {
  const match = source.match(/const runtimeDependencies = \{([\s\S]*?)\n\}/m)
  if (!match) throw new Error('runtime.js must declare a runtimeDependencies bag')
  return match[1]
    .split('\n')
    .map((line) => line.trim().replace(/,$/, '').split(':')[0].trim())
    .filter((name) => /^[a-zA-Z_]\w*$/.test(name))
}

export function buildManifest() {
  const declared = declaredDependencies(readFileSync(RUNTIME_FILE, 'utf8'))
  const consumed = new Set()
  const unresolved = []
  for (const file of walkJavaScriptFiles(LOOP_ROOT)) {
    if (path.resolve(file) === path.resolve(MANIFEST_FILE)) continue
    const result = collectConsumedDependencies(readFileSync(file, 'utf8'), path.relative(REPO_ROOT, file))
    for (const name of result.consumed) consumed.add(name)
    unresolved.push(...result.unresolved)
  }
  const required = [...consumed].sort()
  const declaredSorted = [...new Set(declared)].sort()
  return {
    required,
    declared: declaredSorted,
    retained: declaredSorted.filter((name) => !consumed.has(name)),
    unresolved,
  }
}

function renderManifest(manifest) {
  const lines = [
    '/**',
    ' * Generated by scripts/generate-loop-dependency-manifest.mjs. Do not edit by hand.',
    ' *',
    ' * `required` is every symbol the loop phases consume through the shared',
    ' * dependency bag, extracted with acorn (property access, literal string index,',
    ' * destructuring aliases, defaults and nested patterns). The runtime boundary',
    ' * fails closed when any required symbol is absent.',
    ' *',
    ' * `declared` is the runtimeDependencies object itself, used to detect drift',
    ' * (dead entries or accidental removals) in the coverage audit.',
    ' */',
    'export const LOOP_RUNTIME_DEPENDENCY_MANIFEST = Object.freeze({',
    '  schemaVersion: 1,',
    '  required: Object.freeze([',
    ...manifest.required.map((name) => `    '${name}',`),
    '  ]),',
    '  declared: Object.freeze([',
    ...manifest.declared.map((name) => `    '${name}',`),
    '  ]),',
    '  retained: Object.freeze([',
    ...manifest.retained.map((name) => `    '${name}',`),
    '  ]),',
    '})',
    '',
  ]
  return lines.join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const manifest = buildManifest()
  if (manifest.unresolved.length > 0) {
    process.stderr.write('[deps] unresolved dynamic state-bag access:\n')
    for (const entry of manifest.unresolved) {
      process.stderr.write(`  - ${entry.file}: ${entry.reason}\n`)
    }
    process.exitCode = 1
    return
  }
  const rendered = renderManifest(manifest)
  const current = (() => {
    try { return readFileSync(MANIFEST_FILE, 'utf8') } catch { return null }
  })()
  if (check) {
    if (current !== rendered) {
      process.stderr.write('[deps] dependencyBagManifest.js is stale; run without --check to regenerate\n')
      process.exitCode = 1
    }
    return
  }
  if (current !== rendered) writeFileSync(MANIFEST_FILE, rendered)
  process.stdout.write(`[deps] required=${manifest.required.length} declared=${manifest.declared.length} retained=${manifest.retained.length}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

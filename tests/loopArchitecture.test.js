import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOOP_ROOT = path.join(REPO_ROOT, 'server', 'services', 'loop')
const PUBLIC_LOOP_ENTRY = path.join(LOOP_ROOT, 'index.js')
const MAX_KERNEL_LINES = 600

const PUBLIC_ENTRY_CONSUMERS = [
  'server/services/turnEngineHost.js',
  'server/services/jobPlanningExplorationRuntime.js',
  'server/services/jobStepExecutionRuntime.js',
  'server/services/jobTools.js',
]

const ARCHITECTURE_CONSUMERS = [
  'server/services/TurnEngine.js',
  'server/services/turnExecutionRuntime.js',
  'server/services/turnLoopExecutionRuntime.js',
  'server/services/turnSchedulingRuntime.js',
  'server/services/jobRuntime.js',
  ...PUBLIC_ENTRY_CONSUMERS,
]

function sortPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function walkJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => sortPaths(left.name, right.name))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return walkJavaScriptFiles(absolute)
      return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : []
    })
}

function kernelFiles() {
  return [
    path.join(REPO_ROOT, 'server', 'services', 'toolLoopRuntime.js'),
    path.join(REPO_ROOT, 'server', 'services', 'toolLoopHeuristics.js'),
    ...walkJavaScriptFiles(LOOP_ROOT),
  ]
}

function architectureFiles() {
  return [
    ...kernelFiles(),
    ...ARCHITECTURE_CONSUMERS.map((file) => path.join(REPO_ROOT, file)),
  ]
}

function boundaryFiles() {
  return [
    ...kernelFiles(),
    path.join(REPO_ROOT, 'server', 'services', 'subagentBatchBridge.js'),
    path.join(REPO_ROOT, 'server', 'services', 'subagentApprovalContext.js'),
    path.join(REPO_ROOT, 'server', 'services', 'subagentRuntime.js'),
  ]
}

function sourceLineCount(source) {
  if (source.length === 0) return 0
  const lines = source.split(/\r\n|\n|\r/).length
  return lines - (/(?:\r\n|\n|\r)$/.test(source) ? 1 : 0)
}

function repoPath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

function canonicalPath(file) {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseModule(file) {
  return parse(readFileSync(file, 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
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

function relativeImportSpecifiers(ast) {
  const specifiers = new Set()
  walkAst(ast, (node) => {
    if (
      (node.type === 'ImportDeclaration'
        || node.type === 'ExportNamedDeclaration'
        || node.type === 'ExportAllDeclaration')
      && typeof node.source?.value === 'string'
      && node.source.value.startsWith('.')
    ) {
      specifiers.add(node.source.value)
    }
    if (
      node.type === 'ImportExpression'
      && typeof node.source?.value === 'string'
      && node.source.value.startsWith('.')
    ) {
      specifiers.add(node.source.value)
    }
  })
  return [...specifiers].sort(sortPaths)
}

function resolveRelativeModule(fromFile, specifier) {
  const target = path.resolve(path.dirname(fromFile), specifier)
  const candidates = path.extname(target)
    ? [target]
    : [`${target}.js`, path.join(target, 'index.js')]
  return candidates.find((candidate) => existsSync(candidate)) ?? target
}

function buildImportGraph(files) {
  const kernelByCanonicalPath = new Map(
    files.map((file) => [canonicalPath(file), file]),
  )
  return new Map(files.map((file) => {
    const dependencies = relativeImportSpecifiers(parseModule(file))
      .map((specifier) => resolveRelativeModule(file, specifier))
      .map(canonicalPath)
      .filter((dependency) => kernelByCanonicalPath.has(dependency))
      .map((dependency) => kernelByCanonicalPath.get(dependency))
      .sort(sortPaths)
    return [file, dependencies]
  }))
}

function findImportCycle(graph) {
  const states = new Map()
  const stack = []

  function visit(file) {
    states.set(file, 'visiting')
    stack.push(file)
    for (const dependency of graph.get(file) ?? []) {
      if (states.get(dependency) === 'visiting') {
        const start = stack.indexOf(dependency)
        return [...stack.slice(start), dependency]
      }
      if (!states.has(dependency)) {
        const cycle = visit(dependency)
        if (cycle) return cycle
      }
    }
    stack.pop()
    states.set(file, 'visited')
    return null
  }

  for (const file of [...graph.keys()].sort(sortPaths)) {
    if (states.has(file)) continue
    const cycle = visit(file)
    if (cycle) return cycle
  }
  return null
}

function importExpressionSource(node) {
  let current = node
  while (current?.type === 'AwaitExpression' || current?.type === 'ChainExpression') {
    current = current.argument ?? current.expression
  }
  return current?.type === 'ImportExpression' && typeof current.source?.value === 'string'
    ? current.source.value
    : null
}

function importedName(specifier) {
  if (specifier?.type !== 'ImportSpecifier') return null
  return specifier.imported?.name ?? specifier.imported?.value ?? null
}

function objectPatternHasName(pattern, name) {
  return pattern?.type === 'ObjectPattern' && pattern.properties.some((property) => (
    property.type === 'Property'
    && (property.key?.name ?? property.key?.value) === name
  ))
}

function inspectLoopConsumer(file) {
  const ast = parseModule(file)
  let importsPublicRunToolLoop = false
  const legacyImports = []
  const legacyCalls = []

  walkAst(ast, (node) => {
    if (node.type === 'ImportDeclaration') {
      const target = resolveRelativeModule(file, node.source.value)
      for (const specifier of node.specifiers) {
        const name = importedName(specifier)
        if (canonicalPath(target) === canonicalPath(PUBLIC_LOOP_ENTRY) && name === 'runToolLoop') {
          importsPublicRunToolLoop = true
        }
        if (name === 'runToolsLoop') legacyImports.push(node.source.value)
      }
    }

    if (node.type === 'VariableDeclarator') {
      const source = importExpressionSource(node.init)
      if (source) {
        const target = resolveRelativeModule(file, source)
        if (
          canonicalPath(target) === canonicalPath(PUBLIC_LOOP_ENTRY)
          && objectPatternHasName(node.id, 'runToolLoop')
        ) {
          importsPublicRunToolLoop = true
        }
        if (objectPatternHasName(node.id, 'runToolsLoop')) legacyImports.push(source)
      }
    }

    if (node.type === 'CallExpression') {
      const calleeName = node.callee?.type === 'Identifier'
        ? node.callee.name
        : node.callee?.property?.name ?? node.callee?.property?.value
      if (calleeName === 'runToolsLoop') legacyCalls.push(node.loc?.start.line ?? '?')
    }
  })

  return { importsPublicRunToolLoop, legacyImports, legacyCalls }
}

test('loop kernel production modules stay below 600 source lines', () => {
  const violations = kernelFiles()
    .map((file) => ({ file: repoPath(file), lines: sourceLineCount(readFileSync(file, 'utf8')) }))
    .filter(({ lines }) => lines >= MAX_KERNEL_LINES)
  assert.deepEqual(
    violations,
    [],
    `Split loop kernel modules before they reach ${MAX_KERNEL_LINES} lines`,
  )
})

test('loop architecture relative import graph has no cycles', () => {
  const cycle = findImportCycle(buildImportGraph(architectureFiles()))
  assert.equal(
    cycle,
    null,
    cycle ? `Loop architecture import cycle: ${cycle.map(repoPath).join(' -> ')}` : undefined,
  )
})

test('loop and subagent runtime boundary has no static or dynamic import cycles', () => {
  const files = boundaryFiles()
  const cycle = findImportCycle(buildImportGraph(files))
  assert.equal(
    cycle,
    null,
    cycle ? `Loop boundary import cycle: ${cycle.map(repoPath).join(' -> ')}` : undefined,
  )
})

test('loop consumers use the public runToolLoop entry without legacy calls', () => {
  const violations = PUBLIC_ENTRY_CONSUMERS.flatMap((relativeFile) => {
    const result = inspectLoopConsumer(path.join(REPO_ROOT, relativeFile))
    const issues = []
    if (!result.importsPublicRunToolLoop) issues.push('does not import runToolLoop from loop/index.js')
    if (result.legacyImports.length > 0) {
      issues.push(`imports runToolsLoop from ${result.legacyImports.join(', ')}`)
    }
    if (result.legacyCalls.length > 0) {
      issues.push(`calls runToolsLoop at line ${result.legacyCalls.join(', ')}`)
    }
    return issues.map((issue) => `${relativeFile}: ${issue}`)
  })
  assert.deepEqual(violations, [], 'All runtimes must share the public runToolLoop entry')
})

test('turn loop execution consumes the loop through its injected host port', () => {
  const relativeFile = 'server/services/turnLoopExecutionRuntime.js'
  const file = path.join(REPO_ROOT, relativeFile)
  const source = readFileSync(file, 'utf8')
  const result = inspectLoopConsumer(file)
  assert.equal(
    result.importsPublicRunToolLoop,
    false,
    'turn loop execution must not import the concrete loop implementation',
  )
  assert.match(source, /deps\.runLoop\s*\(/)
})

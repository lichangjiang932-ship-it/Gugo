#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const acorn = require('acorn')

const DEFAULT_ROOT = path.join(__dirname, '..', 'server')
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const FLOW_TYPES = new Set([
  'AwaitExpression',
  'CatchClause',
  'ConditionalExpression',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'IfStatement',
  'ReturnStatement',
  'SwitchCase',
  'ThrowStatement',
  'TryStatement',
  'WhileStatement',
])

function walkFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walkFiles(fullPath, output)
    else if (entry.isFile() && fullPath.endsWith('.js')) output.push(fullPath)
  }
  return output
}

function childNodes(node) {
  const result = []
  for (const [key, value] of Object.entries(node || {})) {
    if (['end', 'loc', 'range', 'start'].includes(key)) continue
    if (Array.isArray(value)) result.push(...value.filter((item) => item?.type))
    else if (value?.type) result.push(value)
  }
  return result
}

function topLevelFunction(node) {
  const declaration = ['ExportDefaultDeclaration', 'ExportNamedDeclaration'].includes(node?.type)
    ? node.declaration
    : node
  return declaration?.type === 'FunctionDeclaration' ? declaration : null
}

function functionMetrics(node, tokens) {
  const codeLines = new Set()
  for (const token of tokens) {
    if (token.start < node.start || token.end > node.end) continue
    for (let line = token.loc.start.line; line <= token.loc.end.line; line += 1) codeLines.add(line)
  }
  const flowLines = new Set()
  function visit(current) {
    const logicalFlow = current.type === 'LogicalExpression'
      && ['&&', '||', '??'].includes(current.operator)
    const nonDefaultCase = current.type !== 'SwitchCase' || current.test !== null
    if ((FLOW_TYPES.has(current.type) && nonDefaultCase) || logicalFlow) {
      flowLines.add(current.loc.start.line)
    }
    for (const child of childNodes(current)) visit(child)
  }
  visit(node.body)
  const codeLineCount = codeLines.size
  return {
    bodyLines: node.loc.end.line - node.loc.start.line + 1,
    codeLines: codeLineCount,
    flowLines: flowLines.size,
    density: codeLineCount > 0 ? (flowLines.size / codeLineCount) * 100 : 0,
  }
}

function auditSource(source, { file = '<source>' } = {}) {
  const tokens = []
  const ast = acorn.parse(source, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    locations: true,
    onToken: tokens,
    sourceType: 'module',
  })
  return ast.body.flatMap((node) => {
    const fn = topLevelFunction(node)
    if (!fn) return []
    return [{
      file,
      line: fn.loc.start.line,
      name: fn.id?.name || '<default>',
      ...functionMetrics(fn, tokens),
    }]
  })
}

function auditFunctionLengths({
  root = DEFAULT_ROOT,
  maxLines = 150,
  minDensity = 8,
} = {}) {
  const records = []
  const parseErrors = []
  for (const filePath of walkFiles(root)) {
    if (/WorkerSource\.js$/u.test(filePath)) continue
    const file = path.relative(path.dirname(root), filePath).split(path.sep).join('/')
    try {
      const source = fs.readFileSync(filePath, 'utf8')
      const fileLines = source.split(/\r?\n/u).length
      records.push(...auditSource(source, { file }).map((record) => ({ ...record, fileLines })))
    } catch (error) {
      parseErrors.push({ file, message: String(error?.message || error) })
    }
  }
  const long = records.filter((record) => record.bodyLines > maxLines)
  const violations = long
    .filter((record) => record.density >= minDensity)
    .sort((left, right) => right.bodyLines - left.bodyLines || left.file.localeCompare(right.file))
  const declarative = long
    .filter((record) => record.density < minDensity)
    .sort((left, right) => right.bodyLines - left.bodyLines || left.file.localeCompare(right.file))
  return {
    root,
    maxLines,
    minDensity,
    totalFunctions: records.length,
    longFunctions: long.length,
    violations,
    declarative,
    parseErrors,
  }
}

function numberArgument(args, name, fallback) {
  const prefix = `--${name}=`
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

function printHuman(result, limit) {
  console.log('=== AST FUNCTION COMPLEXITY AUDIT (server/) ===\n')
  console.log(`top-level functions: ${result.totalFunctions}`)
  console.log(`>${result.maxLines} lines: ${result.longFunctions}`)
  console.log(`complex violations (density >= ${result.minDensity}%): ${result.violations.length}`)
  console.log(`declarative exclusions: ${result.declarative.length}`)
  console.log(`parse errors: ${result.parseErrors.length}`)
  console.log(`\n=== COMPLEX VIOLATIONS: TOP ${Math.min(limit, result.violations.length)} of ${result.violations.length} ===`)
  console.log('lines | flow% | file:line | function | fileLines')
  for (const item of result.violations.slice(0, limit)) {
    console.log(`${String(item.bodyLines).padStart(5)} | ${String(Math.round(item.density)).padStart(4)} | ${item.file}:${item.line} | ${item.name} | ${item.fileLines}`)
  }
  if (result.declarative.length > 0) {
    console.log('\n=== DECLARATIVE EXCLUSIONS ===')
    for (const item of result.declarative) {
      console.log(`${String(item.bodyLines).padStart(5)} | ${String(Math.round(item.density)).padStart(4)} | ${item.file}:${item.line} | ${item.name}`)
    }
  }
  if (result.parseErrors.length > 0) {
    console.log('\n=== PARSE ERRORS ===')
    for (const item of result.parseErrors) console.log(`${item.file}: ${item.message}`)
  }
}

function main(args = process.argv.slice(2)) {
  const result = auditFunctionLengths({
    maxLines: numberArgument(args, 'max-lines', 150),
    minDensity: numberArgument(args, 'min-density', 8),
  })
  const limit = numberArgument(args, 'limit', result.violations.length)
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else printHuman(result, limit)
  if (args.includes('--check') && (result.parseErrors.length > 0 || result.violations.length > 0)) {
    process.exitCode = 1
  }
  return result
}

if (require.main === module) main()

module.exports = { auditFunctionLengths, auditSource, functionMetrics, main, topLevelFunction }

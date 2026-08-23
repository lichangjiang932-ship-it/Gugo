import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

import { parse } from 'acorn'

const LOCAL_MODULE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx'])

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

function unwrapChain(node) {
  return node?.type === 'ChainExpression' ? node.expression : node
}

function evaluateStaticString(node) {
  const expression = unwrapChain(node)
  if (expression?.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value
  }
  if (expression?.type === 'TemplateLiteral') {
    let result = expression.quasis[0]?.value?.cooked
    if (typeof result !== 'string') return null
    for (let index = 0; index < expression.expressions.length; index += 1) {
      const value = evaluateStaticString(expression.expressions[index])
      const suffix = expression.quasis[index + 1]?.value?.cooked
      if (value == null || typeof suffix !== 'string') return null
      result += value + suffix
    }
    return result
  }
  if (expression?.type === 'BinaryExpression' && expression.operator === '+') {
    const left = evaluateStaticString(expression.left)
    const right = evaluateStaticString(expression.right)
    return left == null || right == null ? null : left + right
  }
  return null
}

function memberPropertyName(node) {
  if (node?.type !== 'MemberExpression') return null
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name
  return evaluateStaticString(node.property)
}

function isIdentifier(node, name) {
  return unwrapChain(node)?.type === 'Identifier' && unwrapChain(node).name === name
}

function isProcessObject(node, aliases = new Set()) {
  const expression = unwrapChain(node)
  if (expression?.type === 'Identifier'
    && (expression.name === 'process' || aliases.has(expression.name))) return true
  return expression?.type === 'MemberExpression'
    && isIdentifier(expression.object, 'globalThis')
    && memberPropertyName(expression) === 'process'
}

function isGetBuiltinModuleMember(node, processObjectAliases) {
  const expression = unwrapChain(node)
  return expression?.type === 'MemberExpression'
    && isProcessObject(expression.object, processObjectAliases)
    && memberPropertyName(expression) === 'getBuiltinModule'
}

function objectPatternBindingName(property) {
  if (property?.type !== 'Property' || property.kind !== 'init') return null
  const propertyName = property.computed
    ? evaluateStaticString(property.key)
    : property.key?.name || property.key?.value
  if (propertyName !== 'getBuiltinModule') return null
  if (property.value?.type === 'Identifier') return property.value.name
  if (property.value?.type === 'AssignmentPattern'
    && property.value.left?.type === 'Identifier') return property.value.left.name
  return null
}

function sourceTypeFor(file) {
  return path.extname(file) === '.cjs' ? 'script' : 'module'
}

function formatExpression(source, node) {
  if (!node || !Number.isInteger(node.start) || !Number.isInteger(node.end)) return '<missing>'
  return source.slice(node.start, node.end)
}

export function extractStaticModuleLoads(source, { file = '<source>', sourceType = 'module' } = {}) {
  const program = parse(source, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    locations: true,
    sourceType,
  })
  const createRequireFactories = new Set()
  const moduleNamespaces = new Set()
  const requireLoaders = new Set()
  const processObjectAliases = new Set()
  const getBuiltinModuleLoaders = new Set()
  const loads = []
  const unresolvedLoads = []

  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || !['module', 'node:module'].includes(node.source.value)) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported?.name === 'createRequire') {
        createRequireFactories.add(specifier.local.name)
      } else if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
        moduleNamespaces.add(specifier.local.name)
      }
    }
  }

  const isCreateRequireFactory = (callee) => {
    const expression = unwrapChain(callee)
    if (expression?.type === 'Identifier') return createRequireFactories.has(expression.name)
    return expression?.type === 'MemberExpression'
      && expression.object?.type === 'Identifier'
      && moduleNamespaces.has(expression.object.name)
      && memberPropertyName(expression) === 'createRequire'
  }

  walkAst(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const initializer = unwrapChain(node.init)
      if (initializer?.type === 'CallExpression' && isCreateRequireFactory(initializer.callee)) {
        requireLoaders.add(node.id.name)
      }
    }
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
      const assignment = unwrapChain(node.right)
      if (assignment?.type === 'CallExpression' && isCreateRequireFactory(assignment.callee)) {
        requireLoaders.add(node.left.name)
      }
    }
  })

  let discoveredProcessAlias = true
  while (discoveredProcessAlias) {
    discoveredProcessAlias = false
    const addAlias = (aliases, name) => {
      if (!name || aliases.has(name)) return
      aliases.add(name)
      discoveredProcessAlias = true
    }
    const discoverBinding = (binding, initializer) => {
      const expression = unwrapChain(initializer)
      if (binding?.type === 'Identifier') {
        if (isProcessObject(expression, processObjectAliases)) {
          addAlias(processObjectAliases, binding.name)
        }
        if (isGetBuiltinModuleMember(expression, processObjectAliases)
          || (expression?.type === 'Identifier' && getBuiltinModuleLoaders.has(expression.name))) {
          addAlias(getBuiltinModuleLoaders, binding.name)
        }
        return
      }
      if (binding?.type !== 'ObjectPattern'
        || !isProcessObject(expression, processObjectAliases)) return
      for (const property of binding.properties) {
        addAlias(getBuiltinModuleLoaders, objectPatternBindingName(property))
      }
    }

    walkAst(program, (node) => {
      if (node.type === 'VariableDeclarator') {
        discoverBinding(node.id, node.init)
      } else if (node.type === 'AssignmentExpression' && node.operator === '=') {
        discoverBinding(node.left, node.right)
      }
    })
  }

  const recordLoad = (kind, argument, node, transform = (value) => value) => {
    const value = evaluateStaticString(argument)
    const location = Object.freeze({ file, line: node.loc?.start?.line || null })
    if (value == null) {
      unresolvedLoads.push(Object.freeze({
        ...location,
        expression: formatExpression(source, argument),
        kind,
      }))
      return
    }
    loads.push(Object.freeze({ ...location, kind, specifier: transform(value) }))
  }

  walkAst(program, (node) => {
    if ((node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') && node.source) {
      recordLoad(node.type, node.source, node)
      return
    }
    if (node.type === 'ImportExpression') {
      recordLoad('import()', node.source, node)
      return
    }
    if (node.type !== 'CallExpression') return

    const callee = unwrapChain(node.callee)
    if (callee?.type === 'Identifier'
      && (callee.name === 'require' || requireLoaders.has(callee.name))) {
      recordLoad(callee.name === 'require' ? 'require()' : 'createRequire()', node.arguments[0], node)
      return
    }
    if (callee?.type === 'Identifier' && getBuiltinModuleLoaders.has(callee.name)) {
      recordLoad('process.getBuiltinModule()', node.arguments[0], node, (value) => (
        value.startsWith('node:') ? value : `node:${value}`
      ))
      return
    }
    if (callee?.type === 'CallExpression' && isCreateRequireFactory(callee.callee)) {
      recordLoad('createRequire()()', node.arguments[0], node)
      return
    }
    if (callee?.type === 'MemberExpression'
      && isGetBuiltinModuleMember(callee, processObjectAliases)) {
      recordLoad('process.getBuiltinModule()', node.arguments[0], node, (value) => (
        value.startsWith('node:') ? value : `node:${value}`
      ))
    }
  })

  return Object.freeze({
    loads: Object.freeze(loads),
    unresolvedLoads: Object.freeze(unresolvedLoads),
  })
}

function isFile(file) {
  return existsSync(file) && statSync(file).isFile()
}

function isDirectory(directory) {
  return existsSync(directory) && statSync(directory).isDirectory()
}

function resolveLocalModule(fromFile, specifier) {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return null
  const candidate = path.resolve(path.dirname(fromFile), specifier)
  if (path.extname(candidate)) return isFile(candidate) ? candidate : null
  if (isFile(candidate)) return candidate
  for (const extension of LOCAL_MODULE_EXTENSIONS) {
    const file = `${candidate}${extension}`
    if (isFile(file)) return file
  }
  if (isDirectory(candidate)) {
    for (const extension of LOCAL_MODULE_EXTENSIONS) {
      const file = path.join(candidate, `index${extension}`)
      if (isFile(file)) return file
    }
  }
  return null
}

export function collectStaticModuleGraph(entry) {
  const root = path.resolve(entry)
  const pending = [root]
  const files = new Set()
  const externalLoads = []
  const unresolvedLoads = []
  const unresolvedLocalModules = []

  while (pending.length > 0) {
    const file = pending.pop()
    if (files.has(file)) continue
    files.add(file)
    const source = readFileSync(file, 'utf8')
    const extracted = extractStaticModuleLoads(source, { file, sourceType: sourceTypeFor(file) })
    unresolvedLoads.push(...extracted.unresolvedLoads)
    for (const load of extracted.loads) {
      if (!load.specifier.startsWith('.') && !path.isAbsolute(load.specifier)) {
        externalLoads.push(load)
        continue
      }
      const dependency = resolveLocalModule(file, load.specifier)
      if (dependency) pending.push(dependency)
      else unresolvedLocalModules.push(load)
    }
  }

  return Object.freeze({
    externalLoads: Object.freeze(externalLoads),
    files,
    unresolvedLoads: Object.freeze(unresolvedLoads),
    unresolvedLocalModules: Object.freeze(unresolvedLocalModules),
  })
}

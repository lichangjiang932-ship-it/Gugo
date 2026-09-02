import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dbFacadePath = path.join(repositoryRoot, 'server', 'db.js')
const focusedTables = [
  'users',
  'sessions',
  'login_codes',
  'rate_limits',
  'user_tool_permissions',
]

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/gu, '\n')
}

function importedServicePaths(source, importerPath) {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu),
  ].map((match) => match[1])

  return [...new Set(specifiers)]
    .filter((specifier) => specifier.startsWith('./services/'))
    .map((specifier) => path.resolve(path.dirname(importerPath), specifier))
}

function businessSqlPattern(table) {
  const quotedTable = String.raw`[\x60"\[]?${table}\b`
  const tableClause = String.raw`(?:from|join|into|update|table(?:\s+if\s+(?:not\s+)?exists)?|references)\s+${quotedTable}`
  const indexClause = String.raw`(?:create\s+(?:unique\s+)?index|drop\s+index)\b[\s\S]{0,160}?\bon\s+${quotedTable}`
  const pragmaClause = String.raw`pragma\s+(?:table_info|foreign_key_list)\s*\(\s*${quotedTable}`
  return new RegExp(String.raw`\b(?:${tableClause}|${indexClause}|${pragmaClause})`, 'iu')
}

test('db facade and connection runtime contain no focused business-table SQL', () => {
  const boundaryFiles = [
    dbFacadePath,
    path.join(repositoryRoot, 'server', 'dbRuntime.js'),
  ].filter((filePath) => fs.existsSync(filePath))

  assert.ok(boundaryFiles.length >= 1, 'server/db.js must remain as the public compatibility facade')
  for (const filePath of boundaryFiles) {
    const source = readSource(filePath)
    for (const table of focusedTables) {
      assert.doesNotMatch(
        source,
        businessSqlPattern(table),
        `${path.relative(repositoryRoot, filePath)} must delegate ${table} operations to a focused store`,
      )
    }
  }
})

test('focused stores are injected with the database instead of importing the db facade', () => {
  const facadeSource = readSource(dbFacadePath)
  const servicePaths = importedServicePaths(facadeSource, dbFacadePath)
  const focusedStorePaths = servicePaths.filter((filePath) => {
    if (!fs.existsSync(filePath)) return false
    const source = readSource(filePath)
    return focusedTables.some((table) => businessSqlPattern(table).test(source))
  })

  assert.ok(focusedStorePaths.length > 0, 'db.js must delegate focused table operations to service stores')
  for (const table of focusedTables) {
    assert.ok(
      focusedStorePaths.some((filePath) => businessSqlPattern(table).test(readSource(filePath))),
      `${table} operations must live in a focused service store imported by db.js`,
    )
  }

  for (const filePath of focusedStorePaths) {
    const source = readSource(filePath)
    assert.doesNotMatch(
      source,
      /\b(?:from\s+|import\s*(?:\(|))['"][^'"]*\/db(?:\.js)?['"]/u,
      `${path.relative(repositoryRoot, filePath)} must receive getDb by injection to avoid a cycle`,
    )
  }
})

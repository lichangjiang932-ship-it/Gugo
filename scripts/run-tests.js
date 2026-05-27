#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const selectors = rawArgs.filter((arg) => !arg.startsWith('-'))
const nodeArgs = rawArgs.filter((arg) => arg.startsWith('-') && arg !== '--run')

function allTestFiles() {
  return readdirSync('tests')
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => `tests/${name}`)
}

function resolveSelector(selector) {
  if (selector === 'i18n') return ['tests/i18n.test.js']
  if (selector.startsWith('tests/')) return [selector]
  if (selector.endsWith('.test.js')) return [`tests/${selector}`]
  return [`tests/${selector}.test.js`]
}

const files = selectors.length
  ? selectors.flatMap(resolveSelector)
  : allTestFiles()

const result = spawnSync(process.execPath, ['--test', ...nodeArgs, ...files], {
  stdio: 'inherit',
})

process.exit(result.status ?? 1)

#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const selectors = rawArgs.filter((arg) => !arg.startsWith('-'))
const nodeArgs = rawArgs.filter((arg) => arg.startsWith('-') && arg !== '--run')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.test.js') || entry.endsWith('.test.jsx')) {
      out.push(full)
    }
  }
  return out
}

function allTestFiles() {
  return walk('tests').sort()
}

function resolveSelector(selector) {
  if (selector === 'i18n') return ['tests/i18n.test.js']
  if (selector.startsWith('tests/')) return [selector]
  if (selector.endsWith('.test.js') || selector.endsWith('.test.jsx')) {
    return [`tests/${selector}`]
  }
  return [`tests/${selector}.test.js`]
}

const files = selectors.length
  ? selectors.flatMap(resolveSelector)
  : allTestFiles()

// These tests load rolldown either through the JSX hook or a Vite test
// wrapper. On Windows, running many rolldown instances in node:test workers
// can intermittently terminate a worker with access violation 0xC0000005.
// Run only that small group without an extra test worker; normal JavaScript
// tests keep their fast batched execution.
const viteWrapperTests = new Set([
  normalize('tests/RightPreviewPane.test.js'),
  normalize('tests/slashAutocompleteComponent.test.js'),
])

function requiresNativeTransform(file) {
  return file.endsWith('.jsx') || viteWrapperTests.has(normalize(file))
}

const batchFiles = files.filter((file) => !requiresNativeTransform(file))
const isolatedFiles = files.filter(requiresNativeTransform)

let failed = false

if (batchFiles.length) {
  const result = spawnSync(process.execPath, ['--test', ...nodeArgs, ...batchFiles], {
    stdio: 'inherit',
  })
  if ((result.status ?? 1) !== 0) failed = true
}

function isWindowsNativeCrash(result) {
  return result.status === 3221225477
    || result.status === -1073741819
    || result.signal === 'SIGSEGV'
}

for (const file of isolatedFiles) {
  let passed = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const loaderArgs = file.endsWith('.jsx')
      ? ['--import', './scripts/jsxRegister.mjs']
      : []
    const result = spawnSync(process.execPath, [
      ...loaderArgs,
      ...nodeArgs,
      file,
    ], {
      stdio: 'inherit',
    })

    if (result.status === 0) {
      passed = true
      break
    }
    if (!isWindowsNativeCrash(result) || attempt === 3) break
    console.warn(
      `[run-tests] native transform crashed for ${file}; retrying (${attempt + 1}/3)`,
    )
  }
  if (!passed) failed = true
}

process.exit(failed ? 1 : 0)

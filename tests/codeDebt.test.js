import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const LARGE_FILE_CEILINGS = {
  'src/lib/presentationExport.js': 3630,
  'server/adapters/modelProxy.js': 1971,
  'src/pages/ChatSplit/index.jsx': 1636,
  'server/db.js': 1668,
  'server/services/jobRuntime.js': 1402,
}
const DEBT_MARKER_CEILING = 168
const LEGACY_EMBER_CEILING = 106
const TINY_TEXT_CEILING = 132

function lineCount(file) {
  const source = readFileSync(file, 'utf8')
  return source.split(/\r?\n/).length - (/\r?\n$/.test(source) ? 1 : 0)
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(?:c|m)?jsx?$/.test(entry.name) ? [full] : []
  })
}

function walkUiSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walkUiSources(full)
    return /\.(?:css|jsx?|tsx?)$/.test(entry.name) ? [full] : []
  })
}

function countMatches(files, pattern) {
  return files.reduce((total, file) => total + (readFileSync(file, 'utf8').match(pattern) || []).length, 0)
}

test('known large files can only shrink until they are split', () => {
  const regressions = Object.entries(LARGE_FILE_CEILINGS)
    .map(([file, ceiling]) => ({ file, ceiling, actual: lineCount(file) }))
    .filter(({ actual, ceiling }) => actual > ceiling)
  assert.deepEqual(regressions, [], 'Extract a cohesive module instead of growing a known large file')
})

test('source debt markers cannot increase beyond the cleanup baseline', () => {
  const markers = [new RegExp(['TO', 'DO'].join(''), 'g'), new RegExp(['FIX', 'ME'].join(''), 'g')]
  const count = ['src', 'server', 'tests', 'scripts']
    .flatMap(walk)
    .reduce((total, file) => {
      const source = readFileSync(file, 'utf8')
      return total + markers.reduce((sum, marker) => sum + (source.match(marker) || []).length, 0)
    }, 0)
  assert.ok(count <= DEBT_MARKER_CEILING, `${count} debt markers exceeds ${DEBT_MARKER_CEILING}`)
})

test('legacy ember naming and tiny UI text can only shrink', () => {
  const files = walkUiSources('src')
  const legacyEmber = countMatches(files, /\bember\b/g)
  const tinyText = countMatches(files, /text-\[(?:9|10|11)px\]|font-size:\s*(?:9|10|11)px/g)
  const legacyUtility = /(?:text|bg|border(?:-[trblxy])?|ring|outline|fill|stroke|decoration|shadow|accent|divide|caret)-ember/
  const legacyUtilityFiles = files.filter((file) => legacyUtility.test(readFileSync(file, 'utf8')))

  assert.deepEqual(legacyUtilityFiles, [], 'Use semantic UI tokens instead of ember utility classes')
  assert.ok(legacyEmber <= LEGACY_EMBER_CEILING, `${legacyEmber} legacy ember tokens exceeds ${LEGACY_EMBER_CEILING}`)
  assert.ok(tinyText <= TINY_TEXT_CEILING, `${tinyText} tiny text declarations exceeds ${TINY_TEXT_CEILING}`)
})

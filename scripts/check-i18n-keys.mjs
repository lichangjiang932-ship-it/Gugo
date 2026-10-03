#!/usr/bin/env node
/**
 * Report UI translation keys that are referenced but not defined.
 *
 * Only literal `t('domain.key')` calls can be checked — keys built from a
 * template (t(`workbench.${id}`)) are invisible to any static scan, so this is
 * a floor rather than a proof. It exists because a missing key does not throw:
 * the UI just shows the raw key to the reader.
 *
 * Usage: node scripts/check-i18n-keys.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import { translations } from '../src/i18n/domains/index.js'

const LANGUAGES = ['zh', 'en']

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (/\.(jsx?|mjs)$/u.test(entry.name)) out.push(full)
  }
  return out
}

function referencedKeys() {
  const used = new Map()
  for (const file of collectFiles('src')) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w]*(?:\.[\w]+)+)'\s*[,)]/gu)) {
      if (!used.has(match[1])) used.set(match[1], file)
    }
  }
  return used
}

function flatten(value, prefix = '', out = new Set()) {
  if (!value || typeof value !== 'object') return out
  for (const [key, child] of Object.entries(value)) {
    const path_ = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, path_, out)
    else out.add(path_)
  }
  return out
}

const used = referencedKeys()
const byLanguage = new Map(LANGUAGES.map((language) => [language, flatten(translations?.[language] || {})]))

let missing = 0
for (const language of LANGUAGES) {
  const defined = byLanguage.get(language)
  const gaps = [...used.keys()].filter((key) => !defined.has(key)).sort()
  missing += gaps.length
  console.log(`[${language}] referenced=${used.size} missing=${gaps.length}`)
  for (const key of gaps) console.log(`  ${key}  ←  ${used.get(key)}`)
}

// Symmetry: a key present in only one language silently falls back, and an
// empty value renders as nothing at all — both look like "the UI forgot this".
const zhKeys = byLanguage.get('zh')
const enKeys = byLanguage.get('en')
const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key)).sort()
const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key)).sort()
console.log(`\n[shape] zh=${zhKeys.size} en=${enKeys.size} onlyZh=${onlyZh.length} onlyEn=${onlyEn.length}`)
for (const key of onlyZh.slice(0, 20)) console.log(`  zh-only: ${key}`)
for (const key of onlyEn.slice(0, 20)) console.log(`  en-only: ${key}`)

const empty = []
for (const language of LANGUAGES) {
  for (const [key, value] of Object.entries(flattenDeep(translations?.[language] || {}))) {
    if (!String(value ?? '').trim()) empty.push(`${language}.${key}`)
  }
}

if (missing + onlyZh.length + onlyEn.length + empty.length > 0) {
  console.error(`\nFAIL missing=${missing} onlyZh=${onlyZh.length} onlyEn=${onlyEn.length} empty=${empty.length}`)
  process.exitCode = 1
} else {
  console.log('\nOK: every literal key is defined in both languages and non-empty')
}

/** Flat map (not set) so a value can be inspected. */
function flattenDeep(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value || {})) {
    const path_ = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenDeep(child, path_, out)
    else out[path_] = child
  }
  return out
}

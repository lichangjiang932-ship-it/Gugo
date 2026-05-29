import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../src', import.meta.url))
const BLOCKED = [
  /演示版/,
  /模拟/,
  /占位/,
  /alert\s*\(/,
  /window\.open\s*\(/,
  /手机端配对/,
  // 「二维码」是微信扫码登录的合法 UX 词，不再视为占位
]

function collectFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectFiles(path))
    } else if (/\.(jsx?|tsx?)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

test('visible source does not contain placeholder UI affordances', () => {
  const offenders = []
  for (const file of collectFiles(ROOT)) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of BLOCKED) {
      if (pattern.test(text)) {
        offenders.push(`${file}: ${pattern}`)
      }
    }
  }

  assert.deepEqual(offenders, [])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ASSETS = [
  'react.umd.js',
  'react-dom.umd.js',
  'babel.standalone.js',
  'tailwind.js',
]

const sandboxDir = path.resolve(process.cwd(), 'public/sandbox')

for (const file of ASSETS) {
  test(`public/sandbox/${file} exists and is non-trivial`, () => {
    const full = path.join(sandboxDir, file)
    const stat = fs.statSync(full)
    assert.ok(stat.isFile(), `${file} should be a regular file`)
    assert.ok(stat.size > 10 * 1024, `${file} should be >10KB, got ${stat.size}`)
  })
}

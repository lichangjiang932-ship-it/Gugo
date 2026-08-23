import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ASSETS = {
  'react.umd.js': null,
  'react-dom.umd.js': null,
  'babel.standalone.js': null,
  'tailwind.js': null,
  'mermaid.min.js': '616a109f19cd186842e11d45b35ac07456b3a75513310f6ea075351aa430b1e2',
  'chart.umd.min.js': 'd2af8974e95271638772e9e9524db5b9a6f58d6ec2d5d781400447b4a31c681e',
}

const sandboxDir = path.resolve(process.cwd(), 'public/sandbox')

for (const [file, expectedSha256] of Object.entries(ASSETS)) {
  test(`public/sandbox/${file} exists and is non-trivial`, () => {
    const full = path.join(sandboxDir, file)
    const stat = fs.statSync(full)
    assert.ok(stat.isFile(), `${file} should be a regular file`)
    assert.ok(stat.size > 10 * 1024, `${file} should be >10KB, got ${stat.size}`)
    if (expectedSha256) {
      const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      assert.equal(actualSha256, expectedSha256, `${file} should match its reviewed upstream asset`)
    }
  })
}

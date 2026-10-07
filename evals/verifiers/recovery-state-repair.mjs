import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { projectOutcome } = await import(pathToFileURL(path.resolve('src/recovery.js')).href)
for (const status of ['failed', 'cancelled', 'unknown']) {
  assert.equal(projectOutcome({ status }), status)
}
assert.equal(projectOutcome({ status: 'completed', verificationPassed: true }), 'completed')
for (const value of [null, undefined, {}, [], 'completed',
  { status: 'running', verificationPassed: true },
  { status: 'completed' }, { status: 'completed', verificationPassed: false }]) {
  assert.equal(projectOutcome(value), 'unknown')
}
assert.match(fs.readFileSync('README.md', 'utf8'), /unknown remains unknown/iu)

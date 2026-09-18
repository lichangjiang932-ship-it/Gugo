import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const probePath = fileURLToPath(new URL('../../tools/inkProbe.mjs', import.meta.url))

test('probe self-check is offline and reports its pure-model scope', () => {
  const result = spawnSync(process.execPath, [probePath, '--self-check'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.scope, 'pure-model-only')
  assert.deepEqual(report.checks, { graphemeDeletion: true, cellWrapping: true, ctrlJ: true, crlf: true })
})

test('probe refuses piped stdin rather than leaving a pending raw-mode question', () => {
  const result = spawnSync(process.execPath, [probePath], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /CLI_INK_TTY_REQUIRED/u)
})

test('probe rejects unknown options without reading model or user data', () => {
  const result = spawnSync(process.execPath, [probePath, '--not-supported'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unknown option/u)
})

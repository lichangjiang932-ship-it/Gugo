import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { DEFAULT_CRON_FORM, parseCronGrantsJson } from '../src/pages/cron/useCronJobsController.js'

const editorSource = fs.readFileSync(
  new URL('../src/pages/cron/CronJobEditor.jsx', import.meta.url),
  'utf8',
)
const controllerSource = fs.readFileSync(
  new URL('../src/pages/cron/useCronJobsController.js', import.meta.url),
  'utf8',
)

test('cron editor exposes task grants and sends the parsed array', () => {
  assert.equal(DEFAULT_CRON_FORM.grantsJson, '[]')
  assert.match(editorSource, /t\('cron\.grants'\)/)
  assert.match(editorSource, /t\('cron\.grantsHint'\)/)
  assert.match(editorSource, /form\.grantsJson/)
  assert.match(controllerSource, /grants:\s*parseCronGrantsJson\(form\.grantsJson, t\)/)
})

test('cron task grants parser accepts arrays and rejects malformed or non-array JSON', () => {
  const grant = { tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' }
  assert.deepEqual(parseCronGrantsJson(JSON.stringify([grant])), [grant])
  assert.deepEqual(parseCronGrantsJson(''), [])
  const t = () => 'invalid grants'
  assert.throws(() => parseCronGrantsJson('{', t), /invalid grants/)
  assert.throws(() => parseCronGrantsJson('{}', t), /invalid grants/)
})

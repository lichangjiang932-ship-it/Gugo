import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('router returns async handlers so errorBoundary can observe rejected promises', () => {
  const source = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')

  assert.match(source, /return handleAuthBillingRequest\(req, res, \w+\(\)\)/)
  assert.match(source, /return handleModelStatusRequest\(req, res\)/)
  assert.match(source, /return handleSystemDiagnosticsRequest\(req, res\)/)
  assert.match(source, /return handleModelProxyRequest\(req, res\)/)
  assert.match(source, /return handleToolProxyRequest\(req, res\)/)
  assert.match(source, /return handleJobRequest\(req, res, \w+\)/)
  assert.match(source, /return handleSkillRequest\(req, res\)/)
})

test('fatal process handlers keep logging in production', () => {
  const source = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')

  assert.match(source, /process\.on\('uncaughtException', \(err\) => \{\s*console\.error\('\[server\] uncaughtException:'/)
  assert.match(source, /process\.on\('unhandledRejection', \(reason\) => \{\s*console\.error\('\[server\] unhandledRejection:'/)
})

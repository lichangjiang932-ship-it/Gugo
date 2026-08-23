import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat exposes only the guarded model pre-execution resend path', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /handleRegenerate|onRegenerate/)
  assert.doesNotMatch(source, /flushSync/)
  assert.match(source, /buildModelFailureRetryRequest/)
  assert.match(source, /handleRetryModelFailure/)
  assert.match(source, /if \(!modelReadiness\.canSend\)[\s\S]{0,160}showModelUnavailable\(modelReadiness\)/)
  assert.match(source, /onRetryModelFailure=\{handleRetryModelFailure\}/)
})

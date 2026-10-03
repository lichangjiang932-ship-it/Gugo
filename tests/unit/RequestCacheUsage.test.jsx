import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import RequestCacheUsage from '../../src/pages/ChatSplit/chatMessages/RequestCacheUsage.jsx'
import ContextUsagePanel from '../../src/pages/ChatSplit/chatMessages/ContextUsagePanel.jsx'
import { translateKey } from '../../src/i18n/translations.js'

const t = (key) => translateKey(key, 'en')
const render = (usage) => renderToStaticMarkup(<RequestCacheUsage usage={usage} t={t} />)

test('no request usage means no invented cache measurement', () => {
  assert.equal(render(undefined), '')
  assert.equal(render(null), '')
})

test('unknown read usage remains unknown instead of showing zero percent', () => {
  const html = render({ promptTokens: 1000 })
  assert.match(html, /data-observation="unknown"/)
  assert.match(html, /Not reported/)
  assert.doesNotMatch(html, /\d+%|request-cache-write|request-uncached-input/)
})

test('genuine zero and actual cache writes are preserved independently', () => {
  const html = render({ promptTokens: 1000, cacheHitTokens: 0, cacheCreationTokens: 800, uncachedInputTokens: 200 })
  assert.match(html, /data-observation="reported"/)
  assert.match(html, /0%/)
  assert.match(html, /request-cache-write[^>]*>[\s\S]*?800/)
  assert.match(html, /request-uncached-input[^>]*>[\s\S]*?200/)
})

test('ratio uses the reported request input, never the client context estimate', () => {
  const html = renderToStaticMarkup(<ContextUsagePanel contextUsage={{
    estimatedTokens: 20_000, actualPromptTokens: 1000, contextWindow: 32_000,
    modelUsage: { promptTokens: 1000, cacheHitTokens: 800, cacheCreationTokens: 100, uncachedInputTokens: 100 },
  }} contextWindow={32_000} t={t} />)
  assert.match(html, /Latest request cache/)
  assert.match(html, /80%/)
  assert.doesNotMatch(html, /~800|~100/)
})

test('malformed usage cannot manufacture a percentage and both UI languages have copy', () => {
  for (const cacheHitTokens of [[], [0], {}, true, { valueOf: () => assert.fail('must not coerce objects') }]) {
    const html = render({ promptTokens: 100, cacheHitTokens })
    assert.match(html, /data-observation="unknown"/)
    assert.doesNotMatch(html, /\d+%/)
  }
  assert.match(render({ promptTokens: 10, cacheHitTokens: 100 }), /data-observation="unknown"/)
  assert.doesNotMatch(render({ cacheHitTokens: 5 }), /\d+%/)
  assert.doesNotMatch(render({ promptTokens: 0, cacheHitTokens: 0 }), /NaN|Infinity|\d+%/)
  for (const lang of ['zh', 'en']) {
    const html = renderToStaticMarkup(<RequestCacheUsage usage={{ promptTokens: 100 }} t={(key) => translateKey(key, lang)} />)
    assert.doesNotMatch(html, /chat\.contextUsage\./)
  }
})

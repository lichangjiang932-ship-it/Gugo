import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import ToolCallCard from '../../src/components/ToolCallCard.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

function render(call, props = {}, language = 'en') {
  const previousWindow = globalThis.window
  const hadWindow = Object.hasOwn(globalThis, 'window')
  globalThis.window = { localStorage: { getItem: (key) => key === 'lang' ? language : null } }
  try {
    return renderToStaticMarkup(<I18nProvider><ToolCallCard call={call} stepNumber={1} {...props} /></I18nProvider>)
  } finally {
    if (hadWindow) globalThis.window = previousWindow
    else delete globalThis.window
  }
}

test('collapsed failed tool shows its real reason without opening raw arguments', () => {
  const markup = render({
    name: 'create_pptx', status: 'error', arguments: JSON.stringify({ title: 'Report', slides: [{ private: 'raw slide details' }] }),
    result: JSON.stringify({ ok: false, error: 'slides[0].elements[4]: text frame is too short.' }),
  })
  assert.match(markup, /data-testid="tool-failure-summary"/)
  assert.match(markup, /text frame is too short/)
  assert.match(markup, /class="chat-tool-status" data-status="error"/)
  assert.doesNotMatch(markup, /data-testid="tool-step-details"|raw slide details/)
})

test('failure text is escaped and success never exposes a stale error', () => {
  const error = '<img src=x onerror=alert(1)>'
  assert.match(render({ name: 'run_command', status: 'error', error }), /&lt;img/)
  assert.doesNotMatch(render({ name: 'run_command', status: 'error', error }), /<img/)
  assert.doesNotMatch(render({ name: 'run_command', status: 'success', error }), /tool-failure-summary/)
})

test('source-reading tools use readable action and source descriptions in both languages', () => {
  const call = { name: 'read_artifact_source', status: 'success', arguments: JSON.stringify({ artifact_id: 'source-id' }) }
  assert.match(render(call), /Read editable source/)
  assert.match(render(call), /Editable content of an existing artifact/)
  assert.match(render(call, {}, 'zh'), /读取可编辑源稿/)
  assert.doesNotMatch(render(call, {}, 'zh'), /read_artifact_source|（无）/)
})

test('failed and successful tool colors use semantic status tokens, not the user accent', () => {
  const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
  const errorRule = css.match(/\.chat-tool-step\[data-status="error"\] \.chat-tool-status\s*\{([^}]+)\}/)?.[1] || ''
  const successRule = css.match(/\.chat-tool-step\[data-status="success"\] \.chat-tool-status\s*\{([^}]+)\}/)?.[1] || ''
  assert.match(errorRule, /--color-danger-rgb/)
  assert.doesNotMatch(errorRule, /--color-accent-rgb/)
  assert.match(successRule, /--color-success-rgb/)
})

test('expanding a result containing only an error code still preserves the separate actual cause', () => {
  const call = { name: 'run_command', status: 'error', error: 'The output folder is not writable.', result: { ok: false, code: 'SHELL_FAILED' } }
  for (const expanded of [false, true]) {
    const markup = render(call, { expanded })
    assert.match(markup, /The output folder is not writable/)
  }
})

test('PPT overflow identifies the affected page in the UI language while keeping exact raw diagnostics in details', () => {
  const call = { name: 'create_pptx', status: 'error', errorCode: 'PPTX_CONTENT_OVERFLOW',
    result: { ok: false, code: 'PPTX_CONTENT_OVERFLOW', error: 'PPTX slides[0].elements[4]: content does not fit.' } }
  assert.match(render(call, {}, 'zh'), /第 1 页的第 5 个元素空间不足/)
  const expanded = render(call, { expanded: true }, 'en')
  assert.match(expanded, /Slide 1, element 5 needs more space/)
  assert.match(expanded, /PPTX slides\[0\].elements\[4\]/)
})

test('missing archived argument summaries do not claim the actual call had empty input', () => {
  const markup = render({ name: 'create_pptx', status: 'error', arguments: '{"__artifactReference":{"id":"archived"}}' }, {}, 'zh')
  assert.match(markup, /暂无参数摘要/)
  assert.doesNotMatch(markup, /（空）/)
})

for (const [language, retryLabel, statusLabel] of [['en', 'Retry', 'Failed'], ['zh', '可重试', '失败']]) {
  test(`${language}: expanded failures render complete facts and an escaped hint without exposing credentials`, () => {
    const call = {
      name: 'run_command', status: 'error', errorCode: 'RATE_LIMIT', errorStatus: 429,
      retryable: true, attempts: 2, errorHint: 'Retry after checking <provider>.',
      arguments: JSON.stringify({ command: 'fixture --api_key=argument_private_value123' }),
      result: { ok: false, error: 'Provider rejected the request.', password: 'result_private_value123' },
    }
    const markup = render(call, { expanded: true }, language)
    const facts = markup.match(/<div class="chat-tool-error-facts">([\s\S]*?)<\/div>/)?.[1] || ''
    assert.deepEqual([...facts.matchAll(/<span>([^<]*)<\/span>/g)].map((match) => match[1]), [
      'RATE_LIMIT', 'HTTP 429', '2x', retryLabel,
    ])
    assert.match(markup, /data-testid="tool-step-details"/)
    assert.ok(markup.includes(`<span>${statusLabel}</span>`))
    assert.match(markup, /<div class="chat-tool-error-hint">Retry after checking &lt;provider&gt;\.<\/div>/)
    assert.doesNotMatch(markup, /<provider>|argument_private_value123|result_private_value123/)
    assert.match(markup, /REDACTED/)

    const collapsed = render(call, {}, language)
    assert.match(collapsed, /data-testid="tool-failure-summary"/)
    assert.match(collapsed, /Retry after checking &lt;provider&gt;\./)
    assert.match(collapsed, /aria-expanded="false"/)
    assert.doesNotMatch(collapsed, /data-testid="tool-step-details"|chat-tool-error-facts|argument_private_value123|result_private_value123/)

    const noRetry = render({ ...call, errorStatus: null, attempts: 0, retryable: false }, { expanded: true }, language)
    const noRetryFacts = noRetry.match(/<div class="chat-tool-error-facts">([\s\S]*?)<\/div>/)?.[1] || ''
    assert.equal(noRetryFacts, '<span>RATE_LIMIT</span>')
    const success = render({ ...call, status: 'success' }, { expanded: true }, language)
    assert.doesNotMatch(success, /chat-tool-error-facts|chat-tool-error-hint|tool-failure-summary/)
  })
}

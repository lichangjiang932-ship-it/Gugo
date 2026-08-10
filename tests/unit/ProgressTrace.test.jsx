import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { ProgressTrace } from '../../src/pages/ChatSplit/chatMessages/ActivityTraces.jsx'

function renderProgress(progress) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ProgressTrace progress={progress} />
    </I18nProvider>,
  )
}

test('ProgressTrace renders structured step, iteration, file, and diff progress', () => {
  const markup = renderProgress({
    phase: 'verify', completed: 2, total: 4, iteration: 3,
    filesChanged: 3, additions: 12, deletions: 5,
  })

  assert.match(markup, /data-testid="turn-progress"/)
  assert.match(markup, /阶段：验证中/)
  assert.match(markup, /title="verify"/)
  assert.match(markup, /第 2\/4 步/)
  assert.match(markup, /第 3 轮/)
  assert.match(markup, /3 个文件/)
  assert.match(markup, /\+12 \/ -5/)
  assert.match(markup, /chat-progress-chip-phase/)
  assert.match(markup, /chat-progress-chip-changes/)
  assert.match(markup, /aria-live="polite"/)
})

test('ProgressTrace localizes known machine phases while retaining the raw value', () => {
  const markup = renderProgress({ phase: 'batch_completed', completed: 1, total: 1 })

  assert.match(markup, /阶段：本批次已完成/)
  assert.match(markup, /title="batch_completed"/)
})

test('ProgressTrace omits empty progress objects', () => {
  assert.equal(renderProgress({}), '')
  assert.equal(renderProgress(null), '')
})

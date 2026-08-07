import assert from 'node:assert/strict'
import test from 'node:test'

import { getArtifactToolbarActions } from '../src/pages/ChatSplit/preview/artifactToolbar.js'

test('ordinary web pages use web-file actions instead of presentation actions', () => {
  const actions = getArtifactToolbarActions({
    type: 'html',
    html: '<!doctype html><html><body><main>Calculator</main></body></html>',
  })

  assert.equal(actions.canConvertToPptx, false)
  assert.equal(actions.canExportEditablePptx, false)
  assert.equal(actions.downloadLabelKey, 'chatPreview.downloadHtml')
})

test('presentation-only exports remain scoped to presentation artifacts', () => {
  const pptx = getArtifactToolbarActions({ type: 'pptx' })
  assert.equal(pptx.canExportEditablePptx, true)
  assert.equal(pptx.downloadLabelKey, 'chatPreview.downloadHd')
})

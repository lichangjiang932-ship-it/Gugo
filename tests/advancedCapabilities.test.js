import test from 'node:test'
import assert from 'node:assert/strict'

import { buildArtifactPreview } from '../src/lib/artifactPreview.js'
import { buildToolSpecs, executeToolCall, listToolNames } from '../src/lib/tools/index.js'
import { buildCompaction, validateToolCallChain } from '../server/services/compactionService.js'
import { hasVisionContent, supportsVisionModel } from '../server/adapters/modelProxy.js'
import { replaceUnsupportedVisionContent } from '../server/adapters/visionAssist.js'

test('advanced artifact previews render mermaid, chart, svg, and multi-file html', () => {
  const mermaid = buildArtifactPreview({
    content: 'flowchart TD\nA[Start] --> B[Ship]',
    meta: { artifactType: 'mermaid', artifactTitle: 'Flow' },
  })
  assert.equal(mermaid.type, 'mermaid')
  assert.match(mermaid.html, /mermaid\.initialize/)

  const chart = buildArtifactPreview({
    content: JSON.stringify({ type: 'bar', data: { labels: ['A'], datasets: [{ data: [1] }] } }),
    meta: { artifactType: 'chart', artifactTitle: 'Chart' },
  })
  assert.equal(chart.type, 'chart')
  assert.match(chart.html, /new Chart/)

  const svg = buildArtifactPreview({
    content: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    meta: { artifactType: 'svg', artifactTitle: 'Icon' },
  })
  assert.equal(svg.type, 'svg')
  assert.match(svg.html, /<circle/)

  const multi = buildArtifactPreview({
    content: JSON.stringify({ 'index.html': '<main id="app">Hello</main>', 'styles.css': 'main{color:red}' }),
    meta: { artifactType: 'html_multi', artifactTitle: 'App' },
  })
  assert.equal(multi.type, 'html_multi')
  assert.match(multi.html, /main\{color:red\}/)
})

test('tool registry exposes canvas tools and Agent tool', () => {
  const names = listToolNames()
  for (const name of ['create_mermaid', 'create_chart', 'create_svg', 'create_html_app', 'Agent']) {
    assert.ok(names.includes(name), `${name} should be registered`)
  }
  const specs = buildToolSpecs(['create_mermaid', 'create_chart', 'create_svg', 'create_html_app', 'Agent'])
  assert.deepEqual(specs.map((spec) => spec.function.name), ['Agent', 'create_chart', 'create_html_app', 'create_mermaid', 'create_svg'])
})

test('artifact tools return collapsed preview artifacts and reject unsafe html apps', async () => {
  const svg = await executeToolCall({
    name: 'create_svg',
    arguments: JSON.stringify({ title: 'Icon', svg: '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>' }),
  }, { maxRetries: 0 })
  assert.equal(svg.ok, true)
  assert.equal(svg.artifact.type, 'svg')

  const unsafe = await executeToolCall({
    name: 'create_html_app',
    arguments: JSON.stringify({
      title: 'Unsafe',
      files: { 'index.html': '<script src="https://example.com/app.js"></script>' },
    }),
  }, { maxRetries: 0 })
  assert.equal(unsafe.ok, false)
  assert.match(unsafe.content, /external scripts/)
})

test('compaction preserves tool_call chain when a retained tool message depends on archived assistant call', () => {
  const messages = [
    { role: 'user', content: 'please inspect' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
    { role: 'user', content: 'older filler 1' },
    { role: 'assistant', content: 'older filler 2' },
    { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '{"ok":true}' },
  ]
  const compacted = buildCompaction({ messages, keepMessages: 1 })
  assert.equal(compacted.ok, true)
  assert.equal(compacted.compacted, true)
  assert.equal(validateToolCallChain(compacted.messages).ok, true)
  const toolIndex = compacted.messages.findIndex((message) => message.role === 'tool')
  const callIndex = compacted.messages.findIndex((message) => message.tool_calls?.some((call) => call.id === 'call_1'))
  assert.ok(callIndex >= 0 && callIndex < toolIndex)
})

test('vision helpers enforce MODEL_NAMES_VISION only when configured', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
  assert.equal(hasVisionContent(messages), true)
  assert.equal(supportsVisionModel('text-model', {}), true)
  assert.equal(supportsVisionModel('text-model', { MODEL_NAMES_VISION: 'vision-model' }), false)
  assert.equal(supportsVisionModel('vision-model', { MODEL_NAMES_VISION: 'vision-model' }), true)
})

test('text-only model outbound view replaces image_url/input_image without mutating canonical history', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'between' },
      { type: 'input_image', image_url: 'https://example.test/image.png' },
      { type: 'text', text: 'after' },
    ],
  }]
  const canonicalSnapshot = structuredClone(messages)
  const result = replaceUnsupportedVisionContent({ messages, modelName: 'text-model' })

  assert.equal(result.replacementCount, 2)
  assert.deepEqual(messages, canonicalSnapshot)
  assert.notEqual(result.messages, messages)
  assert.deepEqual(result.messages[0].content.map((part) => part.type), ['text', 'text', 'text', 'text', 'text'])
  assert.equal(result.messages[0].content[0].text, 'before')
  assert.match(result.messages[0].content[1].text, /text-model does not accept vision input/)
  assert.equal(result.messages[0].content[2].text, 'between')
  assert.equal(result.messages[0].content[4].text, 'after')
  assert.equal(hasVisionContent(result.messages), false)
})

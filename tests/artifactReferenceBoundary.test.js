import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactHasInlineReference, remarkArtifactReferences } from '../src/lib/artifactReferenceMarkdown.js'
import { artifactReferenceMatchesHref, findArtifactReferenceBySupersededArtifactHref, normalizeArtifactRelativePath } from '../src/lib/artifactReferencePath.js'
const hosted = { id: 'managed', filename: 'guide.html', url: '/api/artifacts/guide.html' }
const local = { id: 'receipt', filename: 'guide.html', url: 'local-file://fixture', path: 'D:/fixture/docs/guide.html', relatedArtifactIds: ['managed'] }
function inline(value, references) {
  const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value }] }] }
  remarkArtifactReferences({ references })(tree, { value: '`'+value+'`' })
  return tree.children[0].children[0]
}
test('a relative inline reference to a unique hosted-only delivery links instead of hiding its sole fallback', () => {
  assert.equal(inline('docs/guide.html', [hosted]).url, hosted.url)
  assert.equal(artifactHasInlineReference('`docs/guide.html`', hosted, [hosted]), true)
})
test('unresolved/ambiguous inline paths never hide the delivery card, and local receipts cannot use basename fallback', () => {
  for (const value of ['wrong/guide.html', 'https://evil.example/docs/guide.html', '../docs/guide.html']) {
    assert.equal(inline(value, [local]).type, 'inlineCode')
    assert.equal(artifactHasInlineReference('`'+value+'`', local, [local]), false)
  }
  const other = { ...hosted, id: 'another', url: '/api/artifacts/another-guide.html' }
  assert.equal(inline('docs/guide.html', [hosted, other]).type, 'inlineCode')
  assert.equal(artifactHasInlineReference('`docs/guide.html`', hosted, [hosted, other]), false)
  assert.equal(artifactHasInlineReference('```md\n[guide.html](/api/artifacts/guide.html)\n```', hosted, [hosted]), false)
})
test('snapshot rewriting and ordinary matching retain URL origin and reject authority confusion', () => {
  assert.equal(findArtifactReferenceBySupersededArtifactHref([local], '/api/artifacts/guide.html'), local)
  for (const href of ['https://evil.example/api/artifacts/guide.html', '//evil.example/api/artifacts/guide.html', 'https://artifact.local@evil.example/api/artifacts/guide.html']) {
    assert.equal(findArtifactReferenceBySupersededArtifactHref([local], href), null)
    assert.equal(artifactReferenceMatchesHref(hosted, href), false)
    assert.equal(artifactHasInlineReference('[guide.html]('+href+')', hosted, [hosted]), false)
  }
  const original = globalThis.window
  try {
    globalThis.window = { location: { origin: 'http://127.0.0.1:5175' } }
    assert.equal(findArtifactReferenceBySupersededArtifactHref([local], 'http://127.0.0.1:5175/api/artifacts/guide.html'), local)
    assert.equal(artifactReferenceMatchesHref(hosted, 'http://127.0.0.1:5175/api/artifacts/guide.html'), true)
    assert.equal(artifactReferenceMatchesHref(hosted, 'http://127.0.0.1:5176/api/artifacts/guide.html'), false)
  } finally { if (original === undefined) delete globalThis.window; else globalThis.window = original }
})
test('relative path normalization rejects schemes, including percent-encoded schemes', () => {
  for (const path of ['https://evil.example/docs/guide.html', 'mailto:user@example.com/docs/guide.html', 'file:///D:/docs/guide.html', 'https%3A%2F%2Fevil.example%2Fdocs%2Fguide.html']) assert.equal(normalizeArtifactRelativePath(path), '')
  assert.equal(normalizeArtifactRelativePath('./docs/guide.html'), 'docs/guide.html')
})

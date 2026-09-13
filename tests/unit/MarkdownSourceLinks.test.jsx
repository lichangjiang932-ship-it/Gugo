import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownRenderer from '../../src/components/MarkdownRenderer.jsx'

const render = (text, references = []) => renderToStaticMarkup(<MarkdownRenderer artifactReferences={references}>{text}</MarkdownRenderer>)

test('an entire backticked source URL becomes a usable, safely opened hyperlink', () => {
  const markup = render('Source: `https://example.com/reference?section=2`')
  assert.match(markup, /href="https:\/\/example.com\/reference\?section=2"/)
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(markup, /<code/)
})

test('commands, fenced source and credentials do not become new links', () => {
  for (const text of [
    '`curl https://example.com`',
    '```text\nhttps://example.com\n```',
    '`https://name:password@example.com`',
    '`javascript:alert(1)`',
    '`data:text/html,hello`',
  ]) assert.doesNotMatch(render(text), /<a\s[^>]*href=/, text)
})

test('a URL label inside an existing link is never nested into another anchor', () => {
  const markup = render('[`https://example.com`](https://example.com)')
  assert.equal((markup.match(/<a\s/g) || []).length, 1)
})

test('improving source links never makes unverified artifact routes or local paths clickable', () => {
  assert.doesNotMatch(render('`http://localhost/api/artifacts/not-delivered`'), /<a\s/)
  assert.doesNotMatch(render('`D:\\private\\not-delivered.pptx`'), /<a\s/)
  assert.match(render('`https://example.com`'), /<a\s/)
  for (const kind of ['verified', 'retained']) {
    const url = `http://localhost:3123/api/local-files/${kind}/not-delivered?turnId=fake`
    assert.doesNotMatch(render(`\`${url}\``), /<a\s/)
    assert.doesNotMatch(render(`[claimed file](${url})`), /<a\s/)
  }
})

test('short table labels and page numbers stay on one line in a narrow chat pane', () => {
  const markup = render('| 页 | 版式 | 说明 |\n|---|---|---|\n| 10 | 图文混排 | 完整保留较长正文说明并允许正常换行。 |')
  assert.match(markup, /<th[^>]*whitespace-nowrap/)
  assert.match(markup, /<td[^>]*whitespace-nowrap[^>]*>10<\/td>/)
  assert.match(markup, /<td[^>]*whitespace-nowrap[^>]*>图文混排<\/td>/)
  assert.match(markup, /overflow-x-auto/)
})

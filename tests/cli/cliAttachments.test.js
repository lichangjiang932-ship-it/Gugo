import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildPromptWithAttachments,
  classifyAttachment,
  collectAttachmentRequests,
  loadAttachmentObject,
  loadAttachments,
  MAX_ATTACHMENTS,
  parseAttachmentFlags,
} from '../../bin/cli/cliAttachments.js'
import { CliUsageError } from '../../bin/cli/errors.js'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-cli-attach-'))
}

test('attachment flags accept both spellings and leave other arguments alone', () => {
  assert.deepEqual(parseAttachmentFlags([]), { files: [], images: [], rest: [] })
  assert.deepEqual(
    parseAttachmentFlags(['--file', 'a.md', '--image', 'b.png']),
    { files: ['a.md'], images: ['b.png'], rest: [] },
  )
  assert.deepEqual(
    parseAttachmentFlags(['--file=a.md', '--image=b.png']),
    { files: ['a.md'], images: ['b.png'], rest: [] },
  )
  assert.deepEqual(
    parseAttachmentFlags(['analyze this', '--mode', 'plan', '--file', 'x.csv']),
    { files: ['x.csv'], images: [], rest: ['analyze this', '--mode', 'plan'] },
    'unrelated flags and the prompt survive untouched',
  )
  assert.throws(() => parseAttachmentFlags(['--file']), /requires a file path/)
  assert.throws(() => parseAttachmentFlags(['--image=']), /requires a file path/)
})

test('classification is by extension, unknown types stay plain files', () => {
  assert.deepEqual(classifyAttachment('a.PNG'), { kind: 'image', mime: 'image/png' })
  assert.deepEqual(classifyAttachment('a.jpeg'), { kind: 'image', mime: 'image/jpeg' })
  assert.deepEqual(classifyAttachment('a.pdf'), { kind: 'pdf', mime: 'application/pdf' })
  assert.deepEqual(classifyAttachment('notes.md'), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(classifyAttachment('data.json'), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(classifyAttachment('blob.bin'), { kind: 'file', mime: 'application/octet-stream' })
  assert.deepEqual(classifyAttachment(''), { kind: 'file', mime: 'application/octet-stream' })
})

test('the attachment count is capped before anything is read', () => {
  const ok = collectAttachmentRequests({ files: Array(MAX_ATTACHMENTS).fill('a.txt') })
  assert.equal(ok.length, MAX_ATTACHMENTS)
  assert.throws(
    () => collectAttachmentRequests({ files: Array(MAX_ATTACHMENTS + 1).fill('a.txt') }),
    /at most 8 attachments/,
  )
  assert.deepEqual(collectAttachmentRequests({ images: ['a.png'] })[0], { path: 'a.png', kind: 'image' })
})

test('loading produces the shared attachment shape for text, images and pdf', () => {
  const dir = tempDir()
  try {
    const textFile = path.join(dir, 'notes.md')
    fs.writeFileSync(textFile, '# title\nbody\n', 'utf8')
    const text = loadAttachmentObject({ path: textFile, kind: 'auto' })
    assert.equal(text.kind, 'text')
    assert.equal(text.name, 'notes.md')
    assert.equal(text.type, 'text/plain')
    assert.equal(text.text, '# title\nbody\n')
    assert.ok(text.sizeKB >= 1)

    const imageFile = path.join(dir, 'dot.png')
    fs.writeFileSync(imageFile, PNG_1PX)
    const image = loadAttachmentObject({ path: imageFile, kind: 'auto' })
    assert.equal(image.kind, 'image')
    assert.ok(image.dataUrl.startsWith('data:image/png;base64,'))
    assert.equal(image.text, undefined)

    const pdfFile = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfFile, Buffer.from('%PDF-1.4 stub'))
    const pdf = loadAttachmentObject({ path: pdfFile, kind: 'auto' })
    assert.equal(pdf.kind, 'pdf')
    assert.ok(pdf.dataUrl.startsWith('data:application/pdf;base64,'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--image refuses a non-image and loading fails loudly on bad input', () => {
  const dir = tempDir()
  try {
    const textFile = path.join(dir, 'a.txt')
    fs.writeFileSync(textFile, 'x', 'utf8')
    assert.throws(() => loadAttachmentObject({ path: textFile, kind: 'image' }), /--image expects/)

    assert.throws(() => loadAttachmentObject({ path: path.join(dir, 'missing.png') }), /attachment not found/)
    assert.throws(() => loadAttachmentObject({ path: dir }), /is not a file/)
    assert.throws(
      () => loadAttachmentObject({ path: textFile }, { maxBytes: 0 }),
      /the limit is 0 KB/,
    )

    assert.deepEqual(loadAttachments([]), [])
    const loaded = loadAttachments([{ path: textFile, kind: 'auto' }])
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].kind, 'text')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the flattened prompt carries text attachments inline and refuses multimodal parts', () => {
  assert.equal(buildPromptWithAttachments('look at this', []), 'look at this')
  assert.equal(buildPromptWithAttachments('', []), '请分析附件内容。', 'an empty prompt still asks for the attachment')

  const text = buildPromptWithAttachments('summarise', [
    { kind: 'text', name: 'a.md', sizeKB: 2, type: 'text/plain', text: 'body' },
    { kind: 'file', name: 'b.bin', sizeKB: 9, type: 'application/octet-stream' },
  ])
  assert.ok(text.startsWith('summarise'))
  assert.ok(text.includes('[附件: a.md, 2 KB]'))
  assert.ok(text.includes('```\nbody\n```'), 'text attachment content is inlined in a fence')
  assert.ok(text.includes('[附件: b.bin, 9 KB'), 'an opaque file is described by name and size')

  for (const kind of ['image', 'pdf']) {
    assert.throws(
      () => buildPromptWithAttachments('x', [{ kind, name: `f.${kind}`, sizeKB: 1 }]),
      (error) => {
        assert.ok(error instanceof CliUsageError)
        assert.equal(error.code, 'CLI_ATTACHMENT_NEEDS_MULTIMODAL')
        assert.match(error.message, new RegExp(`f\\.${kind}`), 'the offending file is named in the error')
        return true
      },
    )
  }
})

test('every attachment error carries a stable CLI code', () => {
  const dir = tempDir()
  try {
    const textFile = path.join(dir, 'a.txt')
    fs.writeFileSync(textFile, 'x', 'utf8')
    const cases = [
      [() => parseAttachmentFlags(['--file']), 'CLI_ATTACHMENT_PATH_REQUIRED'],
      [() => collectAttachmentRequests({ files: Array(MAX_ATTACHMENTS + 1).fill('a') }), 'CLI_TOO_MANY_ATTACHMENTS'],
      [() => loadAttachmentObject({ path: path.join(dir, 'nope') }), 'CLI_ATTACHMENT_NOT_FOUND'],
      [() => loadAttachmentObject({ path: dir }), 'CLI_ATTACHMENT_NOT_A_FILE'],
      [() => loadAttachmentObject({ path: textFile, kind: 'image' }), 'CLI_ATTACHMENT_NOT_AN_IMAGE'],
      [() => loadAttachmentObject({ path: textFile }, { maxBytes: 0 }), 'CLI_ATTACHMENT_TOO_LARGE'],
    ]
    for (const [run, code] of cases) {
      assert.throws(run, (error) => {
        assert.ok(error instanceof CliUsageError, `${code} must be a CliUsageError`)
        assert.equal(error.code, code)
        return true
      })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

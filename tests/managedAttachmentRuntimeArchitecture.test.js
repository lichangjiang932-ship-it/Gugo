import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function source(file) {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

test('Turn runtime reaches managed attachments only through injected ports', () => {
  for (const file of [
    'server/services/TurnEngine.js',
    'server/services/turnManagedAttachmentRuntime.js',
    'server/services/turnStartRuntime.js',
  ]) {
    const contents = source(file)
    assert.doesNotMatch(contents, /from ['"].*managedAttachmentStore\.js['"]/u, file)
    assert.doesNotMatch(contents, /from ['"].*managedAttachmentContent\.js['"]/u, file)
    assert.doesNotMatch(contents, /from ['"].*\/db\.js['"]/u, file)
    assert.doesNotMatch(contents, /from ['"]node:(?:fs|path)['"]/u, file)
  }
})

test('managed attachment core port does not select a concrete backend', () => {
  const contents = source('server/core/managedAttachmentRuntimePort.js')
  assert.doesNotMatch(contents, /from ['"].*\/adapters\//u)
  assert.doesNotMatch(contents, /from ['"].*\/services\//u)
  assert.doesNotMatch(contents, /from ['"].*\/db\.js['"]/u)
  assert.doesNotMatch(contents, /from ['"]node:(?:fs|path)['"]/u)
})

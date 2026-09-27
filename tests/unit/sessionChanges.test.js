import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countRecordedEditLines,
  sessionFileChanges,
  sessionFileEditIndex,
} from '../../src/lib/sessionChanges.js'

const WORKSPACE = 'D:/work/project'

function message(calls, extra = {}) {
  return { role: 'assistant', meta: { toolCalls: calls }, ...extra }
}

function call({ id, name, args = {}, result = {}, status = '' }) {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
    result: JSON.stringify(result),
    ...(status ? { status } : {}),
  }
}

test('the panel lists what the agent changed, per file and in the order it happened', () => {
  const messages = [
    message([call({
      id: 'c1',
      name: 'edit_file',
      args: { path: 'src/app.js', old_string: 'const one = 1', new_string: 'const one = 2' },
      result: { ok: true, path: 'src/app.js' },
    })]),
    message([call({
      id: 'c2',
      name: 'apply_patch',
      args: { patch: '*** Update File: src/app.js\n@@\n-old\n+new\n*** Add File: docs/notes.md\n+hello' },
      result: {
        ok: true,
        changes: [
          { path: 'src/app.js', additions: 3, deletions: 1 },
          { path: 'docs/notes.md', additions: 12, deletions: 0 },
        ],
      },
    })]),
    message([call({
      id: 'c3',
      name: 'bash_exec',
      args: { command: 'python build.py' },
      result: { ok: true, changedPaths: ['out/report.html'] },
    })]),
  ]

  const { files, totals } = sessionFileChanges(messages, { workspacePath: WORKSPACE })
  // The entry keeps the anchored path for identity and the reader's own form for
  // display; the list shows the second.
  assert.deepEqual(files.map((file) => file.displayPath), ['src/app.js', 'docs/notes.md', 'out/report.html'])
  // The identity is case-folded, the path itself is kept as written.
  assert.deepEqual(files.map((file) => file.path), [
    'D:/work/project/src/app.js', 'D:/work/project/docs/notes.md', 'D:/work/project/out/report.html',
  ])
  // Executor-reported counts stay reported, and are summed across calls.
  assert.deepEqual(files[0].reported, { additions: 3, deletions: 1 })
  assert.deepEqual(files[1].reported, { additions: 12, deletions: 0 })
  // A file only a script touched has no reported counts and no invented ones.
  assert.equal(files[2].reported, null)
  assert.deepEqual(files[2].toolNames, ['bash_exec'])
  assert.deepEqual(totals, { files: 3, reportedFiles: 2, additions: 15, deletions: 1 })
})

test('only successful, non-dry, once-counted mutations are evidence', () => {
  const messages = [
    message([call({ id: 'x1', name: 'write_file', args: { path: 'a.txt', content: 'one\ntwo' }, result: { ok: true, path: 'a.txt' } })]),
    // The same call restored twice in the transcript is one change.
    message([call({ id: 'x1', name: 'write_file', args: { path: 'a.txt', content: 'one\ntwo' }, result: { ok: true, path: 'a.txt' } })]),
    message([call({ id: 'x2', name: 'apply_patch', args: { patch: '*** Update File: b.txt\n-a\n+b', dry_run: true }, result: { ok: true, changes: [{ path: 'b.txt', additions: 1, deletions: 1 }] } })]),
    message([call({ id: 'x3', name: 'edit_file', args: { path: 'c.txt', old_string: 'a', new_string: 'b' }, result: { ok: false, error: 'no match' }, status: 'error' })]),
    message([call({ id: 'x4', name: 'read_file', args: { path: 'd.txt' }, result: { ok: true, path: 'd.txt' } })]),
    // Calls without an id stay distinct: the same edit twice is really two edits.
    message([call({ name: 'write_file', args: { path: 'e.txt', content: 'x' }, result: { ok: true, path: 'e.txt' } })]),
    message([call({ name: 'write_file', args: { path: 'e.txt', content: 'y' }, result: { ok: true, path: 'e.txt' } })]),
  ]

  const { files } = sessionFileChanges(messages)
  assert.deepEqual(files.map((file) => file.displayPath), ['a.txt', 'e.txt'])
  assert.deepEqual(files[1].toolCallIds, [])
})

test('a path inside the project is shown the way the reader thinks of it', () => {
  const messages = [message([call({
    id: 'p1',
    name: 'write_file',
    args: { path: `${WORKSPACE}\\src\\deep\\file.ts` },
    result: { ok: true, path: `${WORKSPACE}\\src\\deep\\file.ts` },
  })])]
  const { files } = sessionFileChanges(messages, { workspacePath: WORKSPACE })
  assert.equal(files[0].displayPath, 'src/deep/file.ts')
  // Outside the project the full path is the honest label.
  const outside = sessionFileChanges([message([
    call({ id: 'p2', name: 'write_file', args: { path: 'E:/elsewhere/x.txt' }, result: { ok: true, path: 'E:/elsewhere/x.txt' } }),
  ])], { workspacePath: WORKSPACE })
  assert.equal(outside.files[0].displayPath, 'E:/elsewhere/x.txt')
})

test('the recorded edits are what the review shows, per tool', () => {
  const messages = [
    message([call({
      id: 'e1',
      name: 'edit_file',
      args: { path: 'src/app.js', old_string: 'one\ntwo', new_string: 'one\nTWO' },
      result: { ok: true, path: 'src/app.js' },
    })]),
    message([call({
      id: 'e2',
      name: 'multi_edit',
      args: {
        path: 'src/app.js',
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      },
      result: { ok: true, path: 'src/app.js' },
    })]),
    message([call({
      id: 'e3',
      name: 'apply_patch',
      args: { patch: '*** Update File: src/other.js\n-keep out\n+other only\n*** Update File: src/app.js\n-old line\n+new line\n+extra' },
      result: { ok: true, changes: [{ path: 'src/other.js', additions: 1, deletions: 1 }, { path: 'src/app.js', additions: 2, deletions: 1 }] },
    })]),
    message([call({
      id: 'e4',
      name: 'write_file',
      args: { path: 'docs/new.md', content: '# title\nbody' },
      result: { ok: true, path: 'docs/new.md' },
    })]),
  ]

  // Both helpers name files the same way, or the panel would look up edits under
  // a key the change list never produced.
  const appKey = sessionFileChanges(messages).files.find((file) => file.displayPath === 'src/app.js').key
  const index = sessionFileEditIndex(messages)
  const appEdits = index.get(appKey)
  assert.deepEqual(appEdits.map((edit) => edit.kind), ['replace', 'replace', 'replace', 'patch'])
  assert.deepEqual(appEdits[0].removed, ['one', 'two'])
  assert.deepEqual(appEdits[0].added, ['one', 'TWO'])
  assert.deepEqual(appEdits[1].added, ['A'])
  assert.deepEqual(appEdits[2].added, ['B'])
  // A patch section is filed under its own file, with only that file's lines.
  assert.deepEqual(appEdits[3].removed, ['old line'])
  assert.deepEqual(appEdits[3].added, ['new line', 'extra'])
  const keyOf = (displayPath) => sessionFileChanges(messages).files.find((file) => file.displayPath === displayPath).key
  assert.deepEqual(index.get(keyOf('src/other.js'))[0].added, ['other only'])
  assert.deepEqual(index.get(keyOf('docs/new.md'))[0].added, ['# title', 'body'])

  // 2/2 (edit_file) + 2/2 (multi_edit) + 2/1 (the patch's own section of this file).
  assert.deepEqual(countRecordedEditLines(appEdits), { additions: 6, deletions: 5 })
  // A file only a script touched has nothing recorded, and nothing is invented.
  assert.equal(index.size, 3, 'only files with a recorded edit are indexed')
  assert.deepEqual(countRecordedEditLines([]), { additions: 0, deletions: 0 })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { executionResultSummary } from '../src/lib/executionResultSummary.js'
import { translateKey } from '../src/i18n/translations.js'

const t = (key, vars) => translateKey(key, 'en').replace(/\{(\w+)\}/g, (_, name) => vars[name])
const success = (name, args, result = {}) => ({ name, status: 'success', arguments: args, result })

test('execution summary counts unique successful file targets, including structured batch results', () => {
  assert.equal(executionResultSummary([
    success('write_file', { path: 'src/a.js' }),
    success('edit_file', JSON.stringify({ path: './src/a.js' })),
    success('multi_edit', {}, { files: ['src/a.js', 'src/b.js', 'src/b.js'] }),
    success('apply_patch', {}, JSON.stringify({ changes: [{ path: 'src/c.js' }] })),
    success('patch_file', {}, { content: JSON.stringify({ ok: true, path: 'src/c.js' }) }),
  ], t), '3 files changed')
})

test('execution summary prefers resolved results and canonicalizes Windows paths without folding POSIX case', () => {
  assert.equal(executionResultSummary([
    success('write_file', { path: 'relative.js' }, { path: 'D:\\work\\A.js' }),
    success('edit_file', {}, { path: 'd:/work/./a.js' }),
    success('write_file', {}, { path: '/work/A.js' }),
    success('write_file', {}, { path: '/work/a.js' }),
  ], t), '3 files changed')
})

test('execution summary excludes running, cancelled, failed, dry-run and non-mutation calls', () => {
  const call = success('write_file', { path: 'a.js' })
  assert.equal(executionResultSummary([
    { ...call, status: 'running' }, { ...call, status: 'cancelled' },
    { ...call, status: 'error', id: 'failed-1' }, { ...call, status: 'error', id: 'failed-1' },
    { ...call, error: 'failed' }, { ...call, result: { ok: false } },
    { ...call, result: { isError: true } },
    { ...call, result: { content: '{"ok":false}' } },
    { ...call, arguments: { path: 'a.js', dryRun: true } },
    { ...call, result: { dry_run: true, path: 'a.js' } },
    success('apply_patch', { dry_run: true }, { changes: [{ path: 'a.js' }] }),
    success('read_file', { path: 'a.js' }),
    success('bash_exec', { command: 'touch a.js' }, { path: 'a.js' }),
  ], t), 'Failed tools: 1')
})

test('execution summary preserves failures alongside committed changes and tolerates missing metadata', () => {
  assert.equal(executionResultSummary([
    success('write_file', { path: 'a.js' }), { status: 'error' },
    null, success('edit_file', '{broken'), success('apply_patch', { patch: '*** Add File: proposed.js' }),
  ], t), '1 file changed · Failed tools: 1')
  for (const calls of [undefined, null, {}, [], [null, {}, success('write_file', { path: {} })]]) {
    assert.equal(executionResultSummary(calls, t), '')
  }
})

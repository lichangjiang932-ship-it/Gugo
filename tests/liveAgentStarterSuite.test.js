import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadLiveEvalDataset } from '../scripts/run-live-agent-evals.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetPath = path.join(root, 'evals', 'starter-suite.json')

test('starter live-eval suite has isolated immutable verifiers and intentionally failing source fixtures', async () => {
  const dataset = await loadLiveEvalDataset(datasetPath)
  assert.deepEqual(dataset.tasks.map((task) => task.id), [
    'starter-counter-repair',
    'starter-config-hardening',
    'starter-report-repair',
    'desktop-multi-file-repair',
    'desktop-cancellation-repair',
    'desktop-recovery-state-repair',
    'desktop-project-path-repair',
    'spec-template-format-repair',
    'spec-dedupe-merge-repair',
    'spec-state-machine-repair',
    'spec-interval-overlap-repair',
  ])
  for (const task of dataset.tasks) {
    assert.equal(task.mode, 'bypass')
    assert.equal(task.verifiers.length, 1)
    const verifier = task.verifiers[0]
    assert.ok(verifier.script)
    assert.equal(path.relative(task.source, verifier.script).startsWith('..'), true)
    const baseline = spawnSync(verifier.command, verifier.args, {
      cwd: task.source,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    })
    assert.notEqual(baseline.status, 0, `${task.id} must begin unsolved`)
  }
})

const solutions = {
  'desktop-multi-file-repair': {
    'src/totals.js': 'export function sumAmounts(records) { return records.reduce((total, record) => total + (Number.isFinite(record?.amount) ? record.amount : 0), 0) }\n',
    'src/labels.js': "export function labelCount(count) { return count === 1 ? '1 item' : `${count} items` }\n",
    'README.md': 'Negative amounts are included.\n',
  },
  'desktop-cancellation-repair': {
    'src/worker.js': `export async function runTask({signal, work}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', aborted)
      action(value)
    }
    const aborted = () => finish(reject, signal.reason)
    signal?.addEventListener('abort', aborted, {once: true})
    Promise.resolve().then(() => { signal?.throwIfAborted(); return work(signal) })
      .then((value) => finish(resolve, value), (error) => finish(reject, error))
  })
}\n`,
  },
  'desktop-recovery-state-repair': {
    'src/recovery.js': `export function projectOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  if (['failed', 'cancelled', 'unknown'].includes(value.status)) return value.status
  return value.status === 'completed' && value.verificationPassed === true ? 'completed' : 'unknown'
}\n`,
    'README.md': 'Unknown remains unknown.\n',
  },
  'desktop-project-path-repair': {
    'src/paths.js': String.raw`import path from 'node:path'
export function resolveTarget(projectRoot, target) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof target !== 'string' || !target.trim()) throw new Error('invalid path')
  const api = /^[a-z]:[\\/]|^\\\\/i.test(projectRoot) ? path.win32 : path.posix
  if (!api.isAbsolute(projectRoot) || /^[a-z]:(?:[^\\/]|$)/i.test(target)) throw new Error('invalid root or drive-relative path')
  const root = api.resolve(projectRoot)
  const result = api.resolve(root, target)
  const relative = api.relative(root, result)
  if (relative === '..' || relative.startsWith('..' + api.sep) || api.isAbsolute(relative)) throw new Error('outside project')
  return result
}
`,
  },
  'spec-template-format-repair': {
    'src/template.js': String.raw`export function formatMessage(template, values) {
  const out = []
  const text = String(template)
  for (let i = 0; i < text.length;) {
    if (text[i] === '{' && text[i + 1] === '{') { out.push('{'); i += 2; continue }
    if (text[i] === '}' && text[i + 1] === '}') { out.push('}'); i += 2; continue }
    if (text[i] === '{') {
      const end = text.indexOf('}', i)
      const key = end > i ? text.slice(i + 1, end) : ''
      if (key && /^\w+$/.test(key) && Object.prototype.hasOwnProperty.call(values, key)) {
        out.push(String(values[key])); i = end + 1; continue
      }
    }
    out.push(text[i]); i += 1
  }
  return out.join('')
}
`,
  },
  'spec-dedupe-merge-repair': {
    'src/records.js': `export function mergeById(left, right) {
  const byId = new Map()
  for (const record of left) byId.set(record.id, { ...record })
  for (const record of right) byId.set(record.id, { ...record })
  return [...byId.values()]
}
`,
  },
  'spec-state-machine-repair': {
    'src/machine.js': `const TRANSITIONS = {
  placed: { pay: 'paid', cancel: 'cancelled' },
  paid: { ship: 'shipped', refund: 'refunded' },
  shipped: { deliver: 'delivered', refund: 'refunded' },
}

export function nextStatus(status, event) {
  const row = TRANSITIONS[status]
  if (!row) return null
  return row[event] ?? null
}
`,
  },
  'spec-interval-overlap-repair': {
    'src/interval.js': `export function overlaps(a, b) {
  for (const range of [a, b]) {
    if (typeof range?.start !== 'number' || typeof range?.end !== 'number' || range.start > range.end) {
      throw new Error('invalid interval')
    }
  }
  return a.start <= b.end && b.start <= a.end
}
`,
  },
}

test('new desktop task oracles accept complete repairs and reject an omitted file or document', async (t) => {
  const dataset = await loadLiveEvalDataset(datasetPath)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-eval-oracles-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  for (const task of dataset.tasks.filter((value) => solutions[value.id])) {
    const cwd = path.join(temp, task.id)
    fs.cpSync(task.source, cwd, { recursive: true })
    const patches = solutions[task.id]
    for (const [filename, content] of Object.entries(patches)) fs.writeFileSync(path.join(cwd, filename), content)
    const verifier = task.verifiers[0]
    const complete = spawnSync(verifier.command, verifier.args, {
      cwd, encoding: 'utf8', shell: false, timeout: 30_000,
    })
    assert.equal(complete.status, 0, `${task.id}: ${complete.stderr}`)
    if (patches['README.md']) {
      fs.copyFileSync(path.join(task.source, 'README.md'), path.join(cwd, 'README.md'))
      const missing = spawnSync(verifier.command, verifier.args, {
        cwd, encoding: 'utf8', shell: false, timeout: 30_000,
      })
      assert.notEqual(missing.status, 0, `${task.id} cannot pass without its requested document`)
    }
  }
})

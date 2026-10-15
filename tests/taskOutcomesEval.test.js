import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadLiveEvalDataset } from '../scripts/run-live-agent-evals.mjs'
import { verifyInvoiceReport } from '../evals/verifiers/task-outcomes.mjs'
test('outcome evaluator checks actual deliverables, input preservation, values and CSV escaping rather than success prose', async () => {
  const dataset = await loadLiveEvalDataset(fileURLToPath(new URL('../evals/task-outcomes-suite.json', import.meta.url)))
  assert.equal(dataset.tasks.length, 1)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-outcomes-'))
  try {
    fs.copyFileSync(path.join(dataset.tasks[0].source, 'invoices.json'), path.join(root, 'invoices.json'))
    assert.throws(() => verifyInvoiceReport(root), 'saying done cannot replace outputs')
    fs.mkdirSync(path.join(root, 'reports'))
    fs.writeFileSync(path.join(root, 'reports/unpaid.csv'), 'id,customer,amount_cents\nINV-001,"甲方,北京",1200\nINV-003,"甲方,北京",-200\nINV-004,乙公司,400\n')
    fs.writeFileSync(path.join(root, 'reports/summary.json'), JSON.stringify({ count: 3, total_cents: 1400 }))
    fs.writeFileSync(path.join(root, 'reports/summary.md'), '# Unpaid invoice report\n\n3 invoices: 1400 cents.\n\n[CSV](unpaid.csv) [JSON](summary.json)\n')
    assert.deepEqual(verifyInvoiceReport(root), { files: 3, count: 3, total_cents: 1400 })
    fs.writeFileSync(path.join(root, 'reports/summary.json'), JSON.stringify({ count: 3, total_cents: 1600 }))
    assert.throws(() => verifyInvoiceReport(root), 'dropping negative adjustments must fail')
    fs.writeFileSync(path.join(root, 'invoices.json'), '[]')
    assert.throws(() => verifyInvoiceReport(root), 'editing input to fit an answer must fail')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

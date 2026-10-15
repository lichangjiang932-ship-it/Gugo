import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const sourceFile = fileURLToPath(new URL('../fixtures/task-invoice-report/invoices.json', import.meta.url))
const csvCell = value => /[,"\r\n]/u.test(String(value)) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value)
export function verifyInvoiceReport(root) {
  const realRoot = fs.realpathSync(root)
  const read = relative => {
    const full = path.join(root, relative), stat = fs.lstatSync(full), real = fs.realpathSync(full)
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024)
    assert.ok(real.startsWith(realRoot + path.sep), 'output must remain inside the isolated workspace')
    return fs.readFileSync(full, 'utf8')
  }
  const original = fs.readFileSync(sourceFile, 'utf8')
  assert.equal(read('invoices.json'), original, 'input is immutable')
  const rows = JSON.parse(original).filter(row => row.paid === false).sort((a, b) => a.id.localeCompare(b.id))
  const total = rows.reduce((sum, row) => sum + row.amount_cents, 0)
  const expected = ['id,customer,amount_cents', ...rows.map(row => [row.id, row.customer, row.amount_cents].map(csvCell).join(','))].join('\n')
  assert.equal(read('reports/unpaid.csv').replace(/\r\n/gu, '\n').trimEnd(), expected)
  const summary = JSON.parse(read('reports/summary.json'))
  assert.equal(summary.count, rows.length)
  assert.equal(summary.total_cents, total)
  const markdown = read('reports/summary.md')
  assert.match(markdown, /^# Unpaid invoice report\s*$/mu)
  assert.match(markdown, new RegExp('\\b' + rows.length + '\\b', 'u'))
  assert.match(markdown, new RegExp('\\b' + total + '\\b', 'u'))
  assert.match(markdown, /\]\((?:\.\/)?unpaid\.csv\)/u)
  assert.match(markdown, /\]\((?:\.\/)?summary\.json\)/u)
  return { files: 3, count: rows.length, total_cents: total }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyInvoiceReport(process.cwd())

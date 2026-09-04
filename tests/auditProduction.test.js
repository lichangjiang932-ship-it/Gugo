import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIT_EXCEPTIONS,
  inspectProductionAudit,
  runProductionAudit,
} from '../scripts/audit-production.mjs'

const allowedUrls = Object.keys(AUDIT_EXCEPTIONS)

function lock({ imageSize = '1.2.1', pptxgenjs = '4.0.1' } = {}) {
  return {
    packages: {
      'node_modules/image-size': { version: imageSize },
      'node_modules/pptxgenjs': {
        version: pptxgenjs,
        dependencies: { 'image-size': '^1.1.1' },
      },
    },
  }
}

function report(urls = allowedUrls) {
  return {
    vulnerabilities: {
      'image-size': {
        severity: 'high',
        via: urls.map((url) => ({ name: 'image-size', url })),
      },
      pptxgenjs: { severity: 'high', via: ['image-size'] },
    },
  }
}

test('production audit retries transport failures but returns the first valid JSON report', () => {
  const sleeps = []
  let calls = 0
  const valid = { vulnerabilities: {} }
  const result = runProductionAudit({
    delays: [0, 5, 15],
    sleep: (delay) => sleeps.push(delay),
    run: () => {
      calls += 1
      if (calls === 1) return { stdout: '', stderr: 'registry timeout' }
      if (calls === 2) return { stdout: JSON.stringify({ error: { code: 'EAI_AGAIN' } }) }
      return { stdout: JSON.stringify(valid) }
    },
  })
  assert.deepEqual(result, valid)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [5, 15])
})

test('production audit remains fail closed after bounded transport retries', () => {
  let calls = 0
  assert.throws(() => runProductionAudit({
    delays: [0, 0, 0],
    sleep: () => {},
    run: () => {
      calls += 1
      return { stdout: '', stderr: 'registry unavailable' }
    },
  }), /registry unavailable/)
  assert.equal(calls, 3)
})

test('production audit permits only the reviewed image-size advisories', () => {
  const result = inspectProductionAudit(report(), lock(), new Date('2026-08-08T00:00:00Z'))
  assert.deepEqual(result.problems, [])
  assert.deepEqual(result.allowedAdvisories, allowedUrls.sort())
})

test('production audit rejects an unreviewed high-severity advisory', () => {
  const result = inspectProductionAudit(
    report([...allowedUrls, 'https://github.com/advisories/GHSA-new-advisory']),
    lock(),
    new Date('2026-08-08T00:00:00Z'),
  )
  assert.deepEqual(result.problems, [
    'image-size: https://github.com/advisories/GHSA-new-advisory',
  ])
})

test('production audit rejects changed dependency versions and expired exceptions', () => {
  const changed = inspectProductionAudit(report(), lock({ imageSize: '2.0.2' }), new Date('2026-08-08T00:00:00Z'))
  assert.equal(changed.problems.length, 2)
  assert.match(changed.problems[0], /changed from 1\.2\.1 to 2\.0\.2/)

  const expired = inspectProductionAudit(report(), lock(), new Date('2026-11-06T00:00:00Z'))
  assert.equal(expired.problems.length, 2)
  assert.match(expired.problems[0], /exception expired/)
})

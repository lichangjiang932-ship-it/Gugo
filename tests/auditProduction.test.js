import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUDIT_EXCEPTIONS,
  inspectProductionAudit,
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

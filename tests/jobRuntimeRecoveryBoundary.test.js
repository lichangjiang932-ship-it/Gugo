import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const jobRuntimeSource = readFileSync(
  new URL('../server/services/jobRuntime.js', import.meta.url),
  'utf8',
)
const recoverySource = readFileSync(
  new URL('../server/services/jobRuntimeRecovery.js', import.meta.url),
  'utf8',
)

test('job runtime delegates crash recovery to the focused recovery service', () => {
  assert.match(jobRuntimeSource, /recoverRuntimeJobs\(\{/u)

  for (const forbidden of [
    'getLatestJobApproval',
    'releaseAllJobSteeringLeases',
    'JOB_PROCESS_RESTART_RECOVERED',
    'JOB_APPROVAL_RECOVERED',
  ]) {
    assert.equal(
      jobRuntimeSource.includes(forbidden),
      false,
      `jobRuntime.js must not reclaim recovery responsibility: ${forbidden}`,
    )
    assert.equal(
      recoverySource.includes(forbidden),
      true,
      `jobRuntimeRecovery.js must retain recovery responsibility: ${forbidden}`,
    )
  }
})

test('job recovery remains fenced by a short execution lease', () => {
  assert.match(recoverySource, /lease\.isActive\(scope\)/u)
  assert.match(recoverySource, /lease\.acquire\(scope\)/u)
  assert.match(recoverySource, /lease\.runIfOwned\(scope,/u)
  assert.match(recoverySource, /recoveryLease\.release\(\)/u)
})

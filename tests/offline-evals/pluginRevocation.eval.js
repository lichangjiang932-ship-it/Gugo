import assert from 'node:assert/strict'

import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginContributionLifecycle,
} from '../../server/plugins/runtimePluginContributionLifecycle.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function v2Handle(beginRevoke) {
  return attachRuntimePluginBeginRevoke(() => false, beginRevoke)
}

export default defineOfflineEvalSuite({
  id: 'plugin-revocation',
  title: 'Runtime plugin contribution revocation',
  version: 1,
  cases: [
    defineOfflineEvalCase({
      id: 'REV-01',
      category: 'cleanup',
      title: 'revoked visibility remains authoritative when cleanup rejects',
      async run() {
        const lifecycle = createRuntimePluginContributionLifecycle([{
          id: 'tool',
          handle: v2Handle(() => ({
            visibility: 'revoked',
            cleanup: Promise.reject(new Error('cleanup failed after visibility commit')),
          })),
        }])

        const receipt = lifecycle.beginRevoke()
        assert.equal(receipt.visibility, 'revoked')
        await assert.rejects(receipt.cleanup, {
          code: 'PLUGIN_REVOKE_CLEANUP_FAILED',
          message: /cleanup failed after visibility commit/,
        })
        assert.deepEqual(lifecycle.snapshot(), {
          state: 'revoked',
          parts: [{
            id: 'tool',
            state: 'revoked',
            cleanupState: 'failed',
            attempts: 1,
            errorCode: 'PLUGIN_REVOKE_CLEANUP_FAILED',
          }],
        })
        assert.equal(lifecycle.retire(), false)
      },
    }),
    defineOfflineEvalCase({
      id: 'REV-02',
      category: 'retry',
      title: 'retained contribution can be explicitly retried',
      async run() {
        let attempts = 0
        const lifecycle = createRuntimePluginContributionLifecycle([{
          id: 'provider',
          handle: v2Handle(() => {
            attempts += 1
            return attempts === 1
              ? {
                  visibility: 'retained',
                  cleanup: Promise.reject(new Error('host remained visible')),
                }
              : { visibility: 'revoked', cleanup: null }
          }),
        }])

        const first = lifecycle.beginRevoke()
        assert.equal(first.visibility, 'retained')
        await assert.rejects(first.cleanup, /host remained visible/)
        const second = lifecycle.beginRevoke()
        assert.equal(second.visibility, 'revoked')
        await second.cleanup
        assert.equal(attempts, 2)
        assert.equal(lifecycle.retire(), true)
        assert.equal(lifecycle.snapshot().state, 'retired')
      },
    }),
    defineOfflineEvalCase({
      id: 'REV-03',
      category: 'multi-part',
      title: 'partial retry never replays an already revoked contribution',
      async run() {
        let capabilityAttempts = 0
        let toolAttempts = 0
        const lifecycle = createRuntimePluginContributionLifecycle([
          {
            id: 'capability',
            handle: v2Handle(() => {
              capabilityAttempts += 1
              return { visibility: 'revoked', cleanup: null }
            }),
          },
          {
            id: 'tool',
            handle: v2Handle(() => {
              toolAttempts += 1
              return toolAttempts === 1
                ? { visibility: 'retained', cleanup: null }
                : { visibility: 'revoked', cleanup: null }
            }),
          },
        ])

        const first = lifecycle.beginRevoke()
        assert.equal(first.visibility, 'partial')
        await first.cleanup
        assert.equal(lifecycle.snapshot().state, 'partial')

        const second = lifecycle.beginRevoke()
        assert.equal(second.visibility, 'revoked')
        await second.cleanup
        assert.equal(capabilityAttempts, 1)
        assert.equal(toolAttempts, 2)
      },
    }),
  ],
})

import assert from 'node:assert/strict'

import {
  SUBAGENT_PROVIDER_SERVICE,
  invokeRuntimeSubagentProvider,
} from '../../server/services/subagentProvider.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function injectedService(value, observe = () => {}) {
  return async (service, method, args, context) => {
    observe({ service, method, args, context })
    return value
  }
}

export default defineOfflineEvalSuite({
  id: 'subagent-provider',
  title: 'Runtime subagent provider boundary',
  version: 1,
  cases: [
    defineOfflineEvalCase({
      id: 'SUBP-01',
      category: 'boundary',
      title: 'provider receives only a frozen bounded task envelope',
      async run() {
        let received = null
        const result = await invokeRuntimeSubagentProvider({
          runId: 'offline-subagent-1',
          resume: false,
          type: 'explore',
          prompt: 'inspect provider boundary',
          description: 'bounded task',
          depth: 2,
          model: {
            name: 'local-model',
            providerId: 'local-provider',
            configRevision: 7,
            apiKey: 'must-not-cross',
          },
          team: {
            id: 'team-1',
            name: 'Review team',
            mode: 'swarm',
            role: 'reviewer',
            size: 2,
            memberIndex: 1,
            privateField: 'must-not-cross',
          },
          userId: 'private-user',
          skillDefinitions: [{ systemPrompt: 'private skill body' }],
        }, {
          invokePluginService: injectedService({
            found: true,
            pluginId: 'offline-provider',
            value: {
              decision: 'handled',
              status: 'completed',
              text: 'provider completed',
              reason: 'verified',
            },
          }, (call) => {
            received = call
          }),
        })

        assert.equal(received.service, SUBAGENT_PROVIDER_SERVICE)
        assert.equal(received.method, 'run')
        assert.equal(Object.isFrozen(received.args[0]), true)
        assert.equal(Object.isFrozen(received.args[0].model), true)
        assert.equal(Object.isFrozen(received.args[0].team), true)
        assert.equal(Object.isFrozen(received.context), true)
        assert.deepEqual(Object.keys(received.context), ['signal'])
        const serialized = JSON.stringify(received.args[0])
        assert.doesNotMatch(serialized, /private-user|private skill body|must-not-cross/)
        assert.deepEqual(result.terminal, {
          status: 'completed',
          text: 'provider completed',
          reason: 'verified',
        })
      },
    }),
    defineOfflineEvalCase({
      id: 'SUBP-02',
      category: 'fallback',
      title: 'absent and declined providers explicitly select builtin execution',
      async run() {
        const absent = await invokeRuntimeSubagentProvider(
          { runId: 'offline-subagent-absent', prompt: 'fallback', type: 'general' },
          { invokePluginService: injectedService({ found: false }) },
        )
        assert.deepEqual(absent.provenance, {
          pluginId: null,
          service: SUBAGENT_PROVIDER_SERVICE,
          decision: 'absent',
        })
        assert.equal(absent.kind, 'builtin')

        const declined = await invokeRuntimeSubagentProvider(
          { runId: 'offline-subagent-decline', prompt: 'fallback', type: 'general' },
          {
            invokePluginService: injectedService({
              found: true,
              pluginId: 'declining-provider',
              value: { decision: 'decline' },
            }),
          },
        )
        assert.equal(declined.kind, 'builtin')
        assert.deepEqual(declined.provenance, {
          pluginId: 'declining-provider',
          service: SUBAGENT_PROVIDER_SERVICE,
          decision: 'decline',
        })
      },
    }),
    defineOfflineEvalCase({
      id: 'SUBP-03',
      category: 'fail-closed',
      title: 'invalid provider results fail closed with stable provenance',
      async run() {
        await assert.rejects(
          invokeRuntimeSubagentProvider(
            { runId: 'offline-subagent-invalid', prompt: 'invalid', type: 'general' },
            {
              invokePluginService: injectedService({
                found: true,
                pluginId: 'invalid-provider',
                value: {
                  decision: 'handled',
                  status: 'running',
                  text: 'not terminal',
                },
              }),
            },
          ),
          (error) => error?.code === 'SUBAGENT_PROVIDER_RESULT_INVALID'
            && error?.retryable === false
            && error?.providerProvenance?.pluginId === 'invalid-provider'
            && error?.providerProvenance?.decision === 'error',
        )
      },
    }),
  ],
})

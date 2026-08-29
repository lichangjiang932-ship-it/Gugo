import assert from 'node:assert/strict'

import { createLspService } from '../../server/services/lspService.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function definitionResult(uri, line, character) {
  return {
    kind: 'locations',
    resolvedWorkspaceUri: 'file:///workspace',
    locations: [{
      uri,
      range: {
        start: { line, character },
        end: { line, character: character + 8 },
      },
    }],
  }
}

const CASES = [
  defineOfflineEvalCase({
    id: 'LSP-01',
    category: 'task-completion',
    title: 'a go-to-definition task routes by extension and returns a normalized workspace location',
    async run(ctx) {
      const service = createLspService()
      ctx.defer(() => service.close())
      const requests = []
      service.registerProvider({
        id: 'typescript-offline',
        extensionToLanguage: { '.js': 'javascript', '.ts': 'typescript' },
        async query(request) {
          requests.push(request)
          return definitionResult('file:///workspace/src/config.ts', 11, 6)
        },
      })

      const result = await service.query({
        operation: 'goToDefinition',
        filePath: 'D:\\workspace\\src\\main.ts',
        workspaceRoot: 'D:\\workspace',
        position: { line: 28, character: 17 },
      })

      assert.equal(requests.length, 1)
      assert.equal(requests[0].languageId, 'typescript')
      assert.equal(Object.isFrozen(requests[0]), true)
      assert.deepEqual(result, definitionResult('file:///workspace/src/config.ts', 11, 6))
      assert.equal(Object.isFrozen(result), true)
      ctx.metric('providers_consulted', requests.length)
      ctx.metric('locations_returned', result.locations.length)
      ctx.metric('navigation_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'LSP-02',
    category: 'routing-boundary',
    title: 'an unsupported file or operation fails before any language server query is sent',
    async run(ctx) {
      const service = createLspService()
      ctx.defer(() => service.close())
      let providerQueries = 0
      service.registerProvider({
        id: 'typescript-offline',
        extensionToLanguage: { '.ts': 'typescript' },
        async query() {
          providerQueries += 1
          return definitionResult('file:///workspace/src/config.ts', 0, 0)
        },
      })

      await assert.rejects(
        service.query({
          operation: 'goToDefinition',
          filePath: 'D:\\workspace\\README.md',
          workspaceRoot: 'D:\\workspace',
          position: { line: 0, character: 0 },
        }),
        (error) => error?.code === 'LSP_UNAVAILABLE',
      )
      await assert.rejects(
        service.query({
          operation: 'rename',
          filePath: 'D:\\workspace\\src\\main.ts',
          workspaceRoot: 'D:\\workspace',
          position: { line: 0, character: 0 },
        }),
        (error) => error?.code === 'LSP_UNSUPPORTED_OPERATION',
      )

      assert.equal(providerQueries, 0)
      ctx.metric('invalid_tasks_rejected', 2)
      ctx.metric('provider_queries_before_rejection', providerQueries)
      ctx.metric('routing_boundary_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'LSP-03',
    category: 'provider-recovery',
    title: 'a malformed provider answer is rejected without poisoning the next navigation task',
    async run(ctx) {
      const service = createLspService()
      ctx.defer(() => service.close())
      let attempts = 0
      service.registerProvider({
        id: 'recovering-typescript-offline',
        extensionToLanguage: { '.ts': 'typescript' },
        async query() {
          attempts += 1
          return attempts === 1
            ? {
                kind: 'locations',
                resolvedWorkspaceUri: 'file:///workspace',
                locations: [{
                  uri: 'file:///workspace/src/broken.ts',
                  range: {
                    start: { line: 9, character: 4 },
                    end: { line: 8, character: 4 },
                  },
                }],
              }
            : definitionResult('file:///workspace/src/recovered.ts', 4, 2)
        },
      })
      const request = {
        operation: 'findReferences',
        filePath: 'D:\\workspace\\src\\main.ts',
        workspaceRoot: 'D:\\workspace',
        position: { line: 3, character: 7 },
      }

      await assert.rejects(service.query(request), (error) => error?.code === 'LSP_MALFORMED_RESPONSE')
      const recovered = await service.query(request)

      assert.equal(attempts, 2)
      assert.equal(recovered.locations[0].uri, 'file:///workspace/src/recovered.ts')
      ctx.metric('malformed_responses_rejected', 1)
      ctx.metric('subsequent_tasks_completed', 1)
      ctx.metric('recovery_score', 1)
    },
  }),
]

export default defineOfflineEvalSuite({
  id: 'lsp',
  title: 'Language-server navigation tasks, routing denial, and recovery from malformed providers',
  version: 1,
  cases: CASES,
})

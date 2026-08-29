import assert from 'node:assert/strict'

import { runCodeModeWorker } from '../../server/services/codeModeWorkerRuntime.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function task(id, category, title, run) {
  return defineOfflineEvalCase({ id, category, title, run, timeoutMs: 10_000 })
}

const CASES = [
  task(
    'CODE-01',
    'task-completion',
    'a generated analysis program completes a multi-record business task with an exact JSON result',
    async (ctx) => {
      const result = await runCodeModeWorker({
        code: `
          const orders = [
            { id: 'A-1', region: 'north', amount: 120, paid: true },
            { id: 'A-2', region: 'south', amount: 85, paid: false },
            { id: 'A-3', region: 'north', amount: 55, paid: true },
            { id: 'A-4', region: 'west', amount: 210, paid: true },
            { id: 'A-5', region: 'south', amount: 45, paid: true },
          ]
          const paid = orders.filter((order) => order.paid)
          const revenueByRegion = Object.fromEntries(
            [...new Set(paid.map((order) => order.region))]
              .sort()
              .map((region) => [
                region,
                paid.filter((order) => order.region === region)
                  .reduce((sum, order) => sum + order.amount, 0),
              ]),
          )
          return {
            paidRevenue: paid.reduce((sum, order) => sum + order.amount, 0),
            unpaidOrderIds: orders.filter((order) => !order.paid).map((order) => order.id),
            revenueByRegion,
          }
        `,
      })

      assert.equal(result.ok, true)
      assert.deepEqual(result.value, {
        paidRevenue: 430,
        unpaidOrderIds: ['A-2'],
        revenueByRegion: { north: 175, south: 45, west: 210 },
      })
      ctx.metric('records_processed', 5)
      ctx.metric('expected_fields_correct', 3)
      ctx.metric('task_score', 1)
    },
  ),
  task(
    'CODE-02',
    'authority-boundary',
    'generated code can transform data but cannot acquire host file, process, network, or constructor authority',
    async (ctx) => {
      const result = await runCodeModeWorker({
        code: `
          let constructorEscape = 'blocked'
          try {
            constructorEscape = console.log.constructor('return process')().version
          } catch (error) {
            constructorEscape = error.name
          }
          let dynamicCode = 'blocked'
          try {
            dynamicCode = Function('return 7')()
          } catch (error) {
            dynamicCode = error.name
          }
          return {
            processType: typeof process,
            requireType: typeof require,
            fetchType: typeof fetch,
            bufferType: typeof Buffer,
            constructorEscape,
            dynamicCode,
          }
        `,
      })

      assert.equal(result.ok, true)
      assert.deepEqual(result.value, {
        processType: 'undefined',
        requireType: 'undefined',
        fetchType: 'undefined',
        bufferType: 'undefined',
        constructorEscape: 'TypeError',
        dynamicCode: 'EvalError',
      })
      ctx.metric('authority_probes', 6)
      ctx.metric('authority_exposures', 0)
      ctx.metric('boundary_score', 1)
    },
  ),
  task(
    'CODE-03',
    'resource-boundary',
    'a non-terminating generated analysis is stopped with a stable failure instead of hanging the task',
    async (ctx) => {
      const startedAt = Date.now()
      const result = await runCodeModeWorker({
        code: 'while (true) {}',
        computeMs: 100,
        maxWallMs: 1_500,
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.kind, 'timeout')
      assert.ok(Date.now() - startedAt < 5_000, 'non-terminating task exceeded the fail-closed budget')
      ctx.metric('timeout_detected', 1)
      ctx.metric('fail_closed_score', 1)
    },
  ),
]

export default defineOfflineEvalSuite({
  id: 'code-mode',
  title: 'Code Mode task completion, ambient-authority isolation, and resource convergence',
  version: 1,
  cases: CASES,
})

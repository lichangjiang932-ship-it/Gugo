import assert from 'node:assert/strict'

import {
  assertSafeOutboundUrl,
  fetchSafeOutbound,
} from '../../server/utils/outboundNetworkGuard.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }]

const CASES = [
  defineOfflineEvalCase({
    id: 'NET-01',
    category: 'task-completion',
    title: 'a public model discovery task reaches the approved DNS-pinned address without real network access',
    async run(ctx) {
      const attempts = []
      const response = { status: 200, headers: new Headers(), body: null }
      const result = await fetchSafeOutbound('https://models.example/v1/models', {
        headers: { Accept: 'application/json' },
      }, {
        lookup: PUBLIC_DNS,
        dispatcherFactory: (lockedIp) => ({
          lockedIp,
          close: async () => {},
        }),
        fetchImpl: async (url, init) => {
          attempts.push({ url, init })
          assert.equal(init.redirect, 'manual')
          assert.equal(init.dispatcher.lockedIp, '93.184.216.34')
          return response
        },
      })

      assert.equal(result, response)
      assert.equal(attempts.length, 1)
      assert.equal(attempts[0].url, 'https://models.example/v1/models')
      ctx.metric('physical_requests', attempts.length)
      ctx.metric('dns_pinned_requests', attempts.filter((item) => item.init.dispatcher).length)
      ctx.metric('task_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'NET-02',
    category: 'ssrf-boundary',
    title: 'a connector task cannot reach cloud metadata or private DNS answers before fetch starts',
    async run(ctx) {
      const targets = [
        ['http://169.254.169.254/latest/meta-data', 'OUTBOUND_ADDRESS_DENIED'],
        ['http://metadata.google.internal/computeMetadata/v1', 'OUTBOUND_METADATA_DENIED'],
        ['https://rebound.example/private', 'OUTBOUND_ADDRESS_DENIED'],
      ]
      let fetchCalls = 0
      for (const [url, expectedCode] of targets) {
        await assert.rejects(
          fetchSafeOutbound(url, {}, {
            lookup: async () => [{ address: '10.20.30.40', family: 4 }],
            fetchImpl: async () => {
              fetchCalls += 1
              return { status: 200, headers: new Headers() }
            },
          }),
          (error) => error?.code === expectedCode && error?.retryable === false,
        )
      }

      assert.equal(fetchCalls, 0)
      ctx.metric('blocked_targets', targets.length)
      ctx.metric('fetches_before_rejection', fetchCalls)
      ctx.metric('ssrf_rejection_ratio', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'NET-03',
    category: 'redirect-boundary',
    title: 'same-origin redirects are re-resolved and a DNS-rebinding hop is cancelled before its request',
    async run(ctx) {
      let dnsQueries = 0
      let fetchCalls = 0
      let bodyCancellations = 0
      const lookup = async () => {
        dnsQueries += 1
        return [{
          address: dnsQueries === 1 ? '93.184.216.34' : '127.0.0.1',
          family: 4,
        }]
      }

      await assert.rejects(
        fetchSafeOutbound('https://models.example/v1/models', {}, {
          lookup,
          dispatcherFactory: (lockedIp) => ({ lockedIp, close: async () => {} }),
          fetchImpl: async () => {
            fetchCalls += 1
            return {
              status: 302,
              headers: new Headers({ location: '/admin' }),
              body: { cancel: async () => { bodyCancellations += 1 } },
            }
          },
        }),
        (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
      )

      assert.equal(dnsQueries, 2)
      assert.equal(fetchCalls, 1)
      assert.equal(bodyCancellations, 1)
      ctx.metric('redirect_hops_revalidated', 1)
      ctx.metric('rebinding_requests_prevented', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'NET-04',
    category: 'url-policy',
    title: 'credentials and non-HTTP schemes fail with stable policy codes',
    async run(ctx) {
      const attempts = [
        ['https://user:secret@models.example/v1', 'OUTBOUND_CREDENTIALS_DENIED'],
        ['file:///etc/passwd', 'OUTBOUND_PROTOCOL_DENIED'],
      ]
      for (const [url, code] of attempts) {
        await assert.rejects(assertSafeOutboundUrl(url), (error) => error?.code === code)
      }
      ctx.metric('policy_rejections', attempts.length)
      ctx.metric('policy_rejection_ratio', 1)
    },
  }),
]

export default defineOfflineEvalSuite({
  id: 'outbound-network',
  title: 'Outbound task completion with DNS pinning, SSRF denial, and redirect revalidation',
  version: 1,
  cases: CASES,
})

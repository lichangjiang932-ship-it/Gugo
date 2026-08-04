/**
 * SSRF 防护测试 — 覆盖 IP 段判定 + 域名解析黑名单 + DNS rebinding 场景。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { isUnsafeIp, assertSafeOutboundUrl, fetchSafe } from '../server/adapters/toolProxy.js'

/* ── isUnsafeIp ── */

test('isUnsafeIp: IPv4 私有/loopback/link-local/CGNAT 全拒', () => {
  const blocked = [
    '127.0.0.1', '127.5.5.5',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.168.0.255',
    '169.254.169.254', // AWS metadata
    '0.0.0.0',
    '224.0.0.1', '239.255.255.255', // 多播
    '100.64.0.1', '100.127.255.255', // CGNAT
  ]
  for (const ip of blocked) {
    assert.strictEqual(isUnsafeIp(ip), true, `${ip} should be unsafe`)
  }
})

test('isUnsafeIp: IPv4 公网允许', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '142.250.190.78', '52.0.0.1', '99.99.99.99']
  for (const ip of allowed) {
    assert.strictEqual(isUnsafeIp(ip), false, `${ip} should be safe`)
  }
})

test('isUnsafeIp: 172.15 / 172.32 (边界外) 公网允许', () => {
  // 172.16~172.31 才是私有,15 和 32 不是
  assert.strictEqual(isUnsafeIp('172.15.0.1'), false)
  assert.strictEqual(isUnsafeIp('172.32.0.1'), false)
  assert.strictEqual(isUnsafeIp('172.16.0.1'), true)
  assert.strictEqual(isUnsafeIp('172.31.255.255'), true)
})

test('isUnsafeIp: IPv6 ::1 / fe80 / fc00 / multicast 拒绝', () => {
  assert.strictEqual(isUnsafeIp('::1'), true)
  assert.strictEqual(isUnsafeIp('::'), true)
  assert.strictEqual(isUnsafeIp('fe80::1'), true)
  assert.strictEqual(isUnsafeIp('fe80::abcd:1234'), true)
  assert.strictEqual(isUnsafeIp('fc00::1'), true)
  assert.strictEqual(isUnsafeIp('fd12::1'), true)
  assert.strictEqual(isUnsafeIp('ff02::1'), true)
})

test('isUnsafeIp: IPv6 公网允许', () => {
  assert.strictEqual(isUnsafeIp('2001:4860:4860::8888'), false) // Google DNS
  assert.strictEqual(isUnsafeIp('2606:4700:4700::1111'), false) // Cloudflare DNS
})

test('isUnsafeIp: ::ffff:<v4 私网> 映射也拒绝', () => {
  assert.strictEqual(isUnsafeIp('::ffff:127.0.0.1'), true)
  assert.strictEqual(isUnsafeIp('::ffff:192.168.1.1'), true)
  assert.strictEqual(isUnsafeIp('::ffff:169.254.169.254'), true)
})

test('isUnsafeIp: 非法字符串拒绝', () => {
  assert.strictEqual(isUnsafeIp('not-an-ip'), true)
  assert.strictEqual(isUnsafeIp(''), true)
  assert.strictEqual(isUnsafeIp('999.999.999.999'), true)
})

/* ── assertSafeOutboundUrl ── */

test('assertSafeOutboundUrl: 协议非 http/https 拒绝', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('file:///etc/passwd'), /仅支持/)
  await assert.rejects(() => assertSafeOutboundUrl('ftp://example.com'), /仅支持/)
  await assert.rejects(() => assertSafeOutboundUrl('gopher://example.com'), /仅支持/)
  await assert.rejects(() => assertSafeOutboundUrl('ldap://example.com'), /仅支持/)
})

test('assertSafeOutboundUrl: 直接 IP 形式的内网拒绝 (无 DNS 调用)', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('http://127.0.0.1/'), /内网|loopback/)
  await assert.rejects(() => assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/'), /内网|loopback/)
  await assert.rejects(() => assertSafeOutboundUrl('https://10.0.0.1/'), /内网|loopback/)
  await assert.rejects(() => assertSafeOutboundUrl('http://192.168.1.1:8080/admin'), /内网|loopback/)
  await assert.rejects(() => assertSafeOutboundUrl('http://[::1]/'), /内网|loopback/)
})

test('assertSafeOutboundUrl: 不存在域名拒绝', async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl('http://this-host-definitely-does-not-exist-987654321.invalid/'),
    /DNS/,
  )
})

test('assertSafeOutboundUrl: 直接 IP 形式回填 lockedIp 复用同一次审核结果 (C-P2.2)', async () => {
  const target = await assertSafeOutboundUrl('http://8.8.8.8/')
  // 复用已审核的 IP,不再二次解析
  assert.strictEqual(target.lockedIp, '8.8.8.8')
})

test('assertSafeOutboundUrl: 非法 URL 拒绝', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('not a url'), /url/)
  await assert.rejects(() => assertSafeOutboundUrl(''), /url/)
})

test('fetchSafe revalidates every redirect before making the next request', async () => {
  const validated = []
  const requested = []
  await assert.rejects(
    () => fetchSafe({
      url: 'https://public.example/start',
      validateUrl: async (raw) => {
        validated.push(raw)
        if (raw.includes('169.254.169.254')) throw new Error('blocked private redirect')
        const target = new URL(raw)
        target.lockedIp = '203.0.113.10'
        return target
      },
      requestImpl: async ({ url }) => {
        requested.push(url)
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: '',
          _redirectTo: 'http://169.254.169.254/latest/meta-data/',
        }
      },
    }),
    /blocked private redirect/,
  )
  assert.deepEqual(validated, [
    'https://public.example/start',
    'http://169.254.169.254/latest/meta-data/',
  ])
  assert.deepEqual(requested, ['https://public.example/start'])
})

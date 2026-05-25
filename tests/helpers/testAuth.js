/**
 * Test helper:为后台作业/技能等需要鉴权的路由签发一个有效 session token。
 *
 * 实现策略:复用生产 billingAuth 的 issueEmailCode → verifyEmailCode 流程,
 * 这样测试拿到的 token 与真实登录走同一条路径,不需要单独维护「测试模式」分支。
 *
 * 用法:
 *   import { issueTestSession } from './helpers/testAuth.js'
 *   const { token, userId } = issueTestSession({ email: 'user@example.com' })
 *   fetch(url, { headers: { Authorization: `Bearer ${token}` } })
 */
import { issueEmailCode, verifyEmailCode } from '../../server/adapters/billingAuth.js'

let counter = 0

export function issueTestSession({ email } = {}) {
  counter += 1
  // 用进程内 counter 避免同进程多个 test 互相覆盖(login_codes 表按 email 主键)。
  const finalEmail = email || `test-user-${counter}-${process.pid}@example.com`
  const code = '424242'
  issueEmailCode({ email: finalEmail, code })
  const { token, user } = verifyEmailCode({ email: finalEmail, code })
  return { token, userId: user.id, email: finalEmail }
}

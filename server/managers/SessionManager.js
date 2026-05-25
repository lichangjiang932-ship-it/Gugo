/**
 * server/managers/SessionManager.js
 *
 * 面向会话 / 身份的统一门面。
 *
 * 现阶段是薄壳 facade——仅转发 db.js 中的同名函数。
 * 存在的意义：
 *   1. 给 routes / managers 提供唯一 import 点，避免后续多处散脚
 *   2. 未来插中间件（如 audit / cache / i18n error msg）不需要改 caller
 *   3. 给 openhanako 风格的 ManagerRegistry 预留接口
 */

import {
  getSessionByToken,
  getUserById,
  getUserByEmail,
  createUser,
  createSession,
  deleteSession,
} from '../db.js'

export const SessionManager = {
  /** 根据 Bearer token 取会话记录 */
  getSessionByToken,

  /** 按 ID 查用户 */
  getUserById,

  /** 按邮箱查用户（重发验证码 / 密码登录使用）*/
  getUserByEmail,

  /** 创建新用户 */
  createUser,

  /** 创建会话（验证码 / 密码登录成功后）*/
  createSession,

  /** 删会话（登出）*/
  deleteSession,
}

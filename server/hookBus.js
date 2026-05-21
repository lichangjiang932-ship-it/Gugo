/**
 * 单进程事件总线（底座 B）
 *
 * 四个 channel:
 *   - user_prompt_submit : 用户首条 prompt 提交前（modelProxy 触发）
 *   - pre_tool_use       : 工具分发前（所有 dispatcher 触发）
 *   - post_tool_use      : 工具分发后（无论成功/失败）
 *   - stop               : 一轮 assistant 流结束（modelProxy 触发）
 *
 * 监听者签名: async (ctx) => ({ allow?: boolean, replacement?, reason? })
 *   - 阻塞型: allow === false 表示否决（fire 返回 { allowed:false, reason }）
 *   - 透传型: 不返回或返回 { allow:true }，可附带 replacement 修改入参
 *
 * 监听者数组顺序执行；一旦有人否决，立即短路。
 */

import { EventEmitter } from 'node:events'

const CHANNELS = ['user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop']

const _listeners = new Map()
for (const ch of CHANNELS) _listeners.set(ch, [])

// 内部 EE 仅用于非关键的「fire-and-forget」观察者，便于做审计
const _observer = new EventEmitter()

export function on(channel, fn, { priority = 100 } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error(`未知 hook channel: ${channel}`)
  const entry = { fn, priority }
  const arr = _listeners.get(channel)
  arr.push(entry)
  arr.sort((a, b) => a.priority - b.priority)
  return () => off(channel, fn)
}

export function off(channel, fn) {
  const arr = _listeners.get(channel)
  if (!arr) return
  const idx = arr.findIndex((e) => e.fn === fn)
  if (idx >= 0) arr.splice(idx, 1)
}

export function clearAll() {
  for (const ch of CHANNELS) _listeners.set(ch, [])
  _observer.removeAllListeners()
}

export function observe(channel, fn) {
  _observer.on(channel, fn)
  return () => _observer.off(channel, fn)
}

/**
 * 同步顺序触发所有 listener；任意一个 throw / 返回 allow:false 即中断。
 *
 * 返回:
 *   { allowed: true,  result?: any, replacement?: object }
 *   { allowed: false, reason: string }
 */
export async function fire(channel, ctx = {}) {
  if (!CHANNELS.includes(channel)) throw new Error(`未知 hook channel: ${channel}`)
  const listeners = _listeners.get(channel).slice()
  let workingCtx = ctx
  for (const { fn } of listeners) {
    let outcome
    try {
      outcome = await fn(workingCtx)
    } catch (err) {
      _observer.emit(channel, { ctx: workingCtx, error: err })
      // listener 抛错：阻塞型 hook 视为拒绝；调用方可通过 ctx.tolerateError 改为放过
      if (workingCtx?.tolerateError) continue
      return { allowed: false, reason: `hook ${channel} 抛错: ${err?.message || err}` }
    }
    if (!outcome) continue
    if (outcome.allow === false) {
      _observer.emit(channel, { ctx: workingCtx, denied: true, reason: outcome.reason })
      return { allowed: false, reason: outcome.reason || `hook ${channel} 拒绝` }
    }
    if (outcome.replacement) {
      workingCtx = { ...workingCtx, ...outcome.replacement }
    }
  }
  _observer.emit(channel, { ctx: workingCtx, ok: true })
  return { allowed: true, ctx: workingCtx }
}

export const HOOK_CHANNELS = CHANNELS

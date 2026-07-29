/**
 * 对话历史裁剪 —— 为上游前缀缓存服务的纯函数。
 *
 * 背景:固定 `slice(-20)` 每轮都从尾部重算,会话一旦超过 20 条,
 * 每发一次就丢掉最老一条 → 序列化后的字节前缀每轮都变。
 * DeepSeek / OpenAI 的自动前缀缓存按「字节相同的前导片段」匹配,
 * 前缀一变命中就塌缩到只剩 system 块 —— 恰恰是长会话最该省钱的时候。
 *
 * 滞回(hysteresis)裁剪:只有超过 HIGH 才裁,一裁就裁到 LOW。
 * 于是窗口在两次裁剪之间保持完全不变,前缀连续稳定 (HIGH - LOW) 轮。
 *
 *   HIGH=30 / LOW=20 → 每 10 轮才破一次前缀,而不是每轮都破。
 */
export const HISTORY_HIGH_WATERMARK = 30
export const HISTORY_LOW_WATERMARK = 20

export function trimHistoryWithHysteresis(
  messages = [],
  { high = HISTORY_HIGH_WATERMARK, low = HISTORY_LOW_WATERMARK } = {},
) {
  if (!Array.isArray(messages)) return []
  // 参数兜底:low 必须小于 high,否则退化回固定窗口
  const hi = Number.isFinite(high) && high > 0 ? Math.floor(high) : HISTORY_HIGH_WATERMARK
  const lo = Number.isFinite(low) && low > 0 && low < hi ? Math.floor(low) : Math.max(1, Math.floor(hi / 2))

  if (messages.length <= hi) return messages.slice()
  // 超过高水位 → 裁到低水位。裁完这一刀后,接下来 (hi - lo) 轮都不会再动。
  return messages.slice(-lo)
}

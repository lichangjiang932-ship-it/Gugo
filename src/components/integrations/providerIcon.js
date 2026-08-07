import { Bot, MessageCircle, Plug } from 'lucide-react'

export function providerIcon(provider) {
  if (provider === 'vision_assist' || provider === 'lark_bot') return Bot
  if (['feishu', 'wechat_official', 'wechat_personal', 'dingtalk', 'qq', 'discord', 'telegram', 'slack'].includes(provider)) return MessageCircle
  return Plug
}

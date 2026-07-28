import { WEB_CONNECTOR_CATALOG } from '../../shared/webConnectorCatalog.js'

const native = (provider, label, brandColor, descriptionKey, hintKey, extra = {}) => Object.freeze({
  provider,
  label,
  brandColor,
  descriptionKey,
  hintKey,
  kind: 'native',
  ...extra,
})

export const NATIVE_ACCESS = Object.freeze([
  native('browser', 'Browser', '#2563EB', 'access.browserDesc', 'access.browserHint'),
  native('notion', 'Notion', '#111111', 'access.notionDesc', 'access.notionHint', { setupUrl: 'https://www.notion.so/profile/integrations' }),
  native('github', 'GitHub', '#24292F', 'access.githubDesc', 'access.githubHint', { setupUrl: 'https://github.com/settings/personal-access-tokens/new' }),
  native('feishu', 'Feishu / Lark', '#3370FF', 'access.feishuDesc', 'access.feishuHint', { setupUrl: 'https://open.feishu.cn/app' }),
  native('wechat_personal', '微信 / WeChat', '#07C160', 'access.wechatDesc', 'access.wechatHint'),
])

export const WEB_ACCESS = Object.freeze(WEB_CONNECTOR_CATALOG.map((connector) => Object.freeze({
  ...connector,
  kind: 'web',
  descriptionKey: 'access.webAppDesc',
})))

export const ACCESS_CATALOG = Object.freeze([...NATIVE_ACCESS, ...WEB_ACCESS])

export function filterAccessCatalog(query) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return ACCESS_CATALOG
  return ACCESS_CATALOG.filter((item) => [item.label, item.provider, item.category, item.searchTerms]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle))
}

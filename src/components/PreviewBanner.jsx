/**
 * PreviewBanner — 顶部粘性提示条
 *
 * 当当前路由在 routeReadiness 中被标记为 'preview' 或 'wip' 时，
 * 在主内容区顶部渲染一条窄横幅提醒用户该页面尚未完善。
 *
 * - preview: bg-paper-2 / text-ink-soft（中性灰）
 * - wip:     bg-amber-50  / text-amber-900（醒目黄）
 *
 * 不打断布局：纯展示型，不拦截事件。
 */
import { useLocation } from '../lib/router.jsx'
import { getBannerKindForPath } from '../config/routeReadiness.js'
import { useT } from '../i18n/I18nProvider.jsx'

export default function PreviewBanner() {
  const location = useLocation()
  const { t } = useT()
  const kind = getBannerKindForPath(location.pathname)
  if (!kind) return null

  const isWip = kind === 'wip'
  const label = isWip ? t('routeReadiness.wip') : t('routeReadiness.preview')
  const body = isWip ? t('routeReadiness.wipBanner') : t('routeReadiness.previewBanner')

  const wrapClass = isWip
    ? 'sticky top-0 z-30 w-full border-b border-amber-300/60 bg-amber-50 text-amber-900'
    : 'sticky top-0 z-30 w-full border-b border-ink-fade/40 bg-paper-2 text-ink-soft'

  const badgeClass = isWip
    ? 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-amber-200/80 text-amber-900'
    : 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-paper border border-ink-fade/50 text-ink-fade'

  return (
    <div role="status" aria-live="polite" className={wrapClass}>
      <div className="max-w-screen-2xl mx-auto px-4 py-1.5 flex items-center gap-2 text-xs">
        <span className={badgeClass}>{label}</span>
        <span className="truncate">{body}</span>
      </div>
    </div>
  )
}

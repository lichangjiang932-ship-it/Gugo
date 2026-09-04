import { ChevronUp, Link2, Settings, Wrench } from 'lucide-react'
import BrandMark from '../BrandMark.jsx'
import DesktopUpdateCard from '../DesktopUpdateCard.jsx'
import { UiContributionRenderer, useUiContributions } from '../../plugins/uiContributionRegistry.js'

export default function AccountArea({ compact = false, accountMenuOpen, accountMenuRef, user, onToggle, onNavigate, t }) {
  const contributedMenuItems = useUiContributions('account-menu')
  return <div ref={accountMenuRef} className="relative border-t border-ink/10 pt-2">
    {accountMenuOpen && <div className={`absolute bottom-full z-30 mb-2 w-56 overflow-hidden rounded-card border border-ink/15 bg-paper p-1.5 shadow-xl ${compact ? 'left-0' : 'left-0 right-0'}`}>
      <MenuButton icon={Link2} label={t('access.title')} onClick={() => onNavigate({ path: '/access', requiresLogin: true })} />
      <MenuButton icon={Settings} label={t('nav.settings')} onClick={() => onNavigate({ path: '/settings', requiresLogin: true })} />
      <MenuButton icon={Wrench} label={t('nav.skills')} onClick={() => onNavigate({ path: '/skills' })} />
      {contributedMenuItems.map((contribution) => contribution.component
        ? <UiContributionRenderer
            key={contribution.key}
            contribution={contribution}
            context={{ onNavigate, t }}
          />
        : <MenuButton
            key={contribution.key}
            icon={contribution.icon || Link2}
            label={contribution.labelKey ? t(contribution.labelKey) : contribution.label}
            onClick={() => onNavigate({ path: contribution.path, requiresLogin: contribution.requiresLogin })}
          />)}
    </div>}
    <DesktopUpdateCard compact={compact} />
    <button type="button" data-settings-focus-return onClick={onToggle} title={compact ? (user.name || t('settings.account')) : undefined} aria-label={user.name || t('settings.account')} aria-expanded={accountMenuOpen} className={`flex h-11 w-full items-center rounded-control text-left transition-colors hover:bg-paper-2 ${compact ? 'justify-center px-0' : 'gap-2.5 px-2'}`}>
      <BrandMark className="h-8 w-8 shrink-0 text-accent-ink" />
      {!compact && <><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">{user.name || t('settings.account')}</span>{user.email && <span className="block truncate text-xs text-ink-fade">{user.email}</span>}</span><ChevronUp className={`h-4 w-4 text-ink-fade transition-transform ${accountMenuOpen ? '' : 'rotate-180'}`} /></>}
    </button>
  </div>
}

function MenuButton({ icon: Icon, label, onClick, badge = 0 }) {
  return <button type="button" onClick={onClick} className="flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-sm text-ink-soft hover:bg-paper-2"><Icon className="h-4 w-4" /><span className="flex-1 text-left">{label}</span>{badge > 0 && <span data-compact-numeric-badge className="rounded-pill bg-accent px-1.5 text-[10px] text-accent-contrast">{badge > 99 ? '99+' : badge}</span>}</button>
}

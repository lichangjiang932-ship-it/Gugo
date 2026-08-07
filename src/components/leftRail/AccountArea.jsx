import { ChevronUp, Link2, Settings, Wrench } from 'lucide-react'
import BrandMark from '../BrandMark.jsx'
import DesktopUpdateCard from '../DesktopUpdateCard.jsx'

export default function AccountArea({ accountMenuOpen, accountMenuRef, user, pendingApprovals, onToggle, onNavigate, t }) {
  return <div ref={accountMenuRef} className="relative border-t border-ink/10 pt-2">
    {accountMenuOpen && <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-ink/15 bg-paper p-1.5 shadow-xl">
      <MenuButton icon={Link2} label={t('access.title')} onClick={() => onNavigate({ path: '/access', requiresLogin: true })} />
      <MenuButton icon={Settings} label={t('nav.settings')} onClick={() => onNavigate({ path: '/settings', requiresLogin: true })} badge={pendingApprovals} />
      <MenuButton icon={Wrench} label={t('nav.skills')} onClick={() => onNavigate({ path: '/skills' })} />
    </div>}
    <DesktopUpdateCard />
    <button type="button" onClick={onToggle} aria-expanded={accountMenuOpen} className="flex h-12 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-paper-2">
      <BrandMark className="h-8 w-8 shrink-0 text-ember" />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{user.name || t('settings.account')}</span>{user.email && <span className="block truncate text-[10px] text-ink-fade">{user.email}</span>}</span>
      <ChevronUp className={`h-4 w-4 text-ink-fade transition-transform ${accountMenuOpen ? '' : 'rotate-180'}`} />
    </button>
  </div>
}

function MenuButton({ icon: Icon, label, onClick, badge = 0 }) {
  return <button type="button" onClick={onClick} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-2"><Icon className="h-4 w-4" /><span className="flex-1 text-left">{label}</span>{badge > 0 && <span className="rounded-full bg-ember px-1.5 text-[10px] text-paper">{badge > 99 ? '99+' : badge}</span>}</button>
}

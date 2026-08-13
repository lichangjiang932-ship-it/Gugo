import { AnimatePresence, motion } from 'framer-motion'
import { LayoutList } from 'lucide-react'

export default function PermissionRequestCard({ request, onAllow, onDeny, onNavigate, t }) {
  return (
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          className="ml-10 rounded-md border border-ember bg-ember-soft p-4 animate-pulse-ember"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[9px] tracking-wider text-ember">{t('chatMessages.permissionRequest', { name: request.skillName })}</span>
          </div>
          <div className="mb-4 flex flex-col gap-1.5">
            {request.perms.map((permission, index) => (
              <div key={`${permission.name}-${index}`} className="flex items-center gap-2 text-sm text-ink-soft">
                <span className="font-mono text-ink-fade">·</span>
                {permission.name} · {permission.detail}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onAllow} className="h-9 rounded-md bg-ember px-4 font-semibold text-sm text-paper transition-colors hover:bg-ember/90">{t('chatMessages.allowContinue')}</button>
            <button onClick={onDeny} className="h-9 rounded-md border border-ink/70 px-4 font-semibold text-sm transition-colors hover:bg-paper-2">{t('chatMessages.deny')}</button>
            <button onClick={onNavigate} className="h-9 rounded-md border border-dashed border-ink-fade/60 px-4 font-semibold text-sm transition-colors hover:border-ink-fade">{t('chatMessages.refineScope')}</button>
            <div className="flex-1" />
            <span className="flex items-center gap-1 text-xs text-ink-soft"><LayoutList className="h-3.5 w-3.5" />{t('chatMessages.permissionHandled')}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

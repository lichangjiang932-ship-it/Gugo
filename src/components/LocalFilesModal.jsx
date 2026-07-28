import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import LocalFilesPanel from './LocalFilesPanel.jsx'

export default function LocalFilesModal({ onClose }) {
  const { t } = useT()

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('localFiles.title')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      <div className="relative w-full max-w-4xl max-h-[88vh] overflow-y-auto rounded-xl border border-ink-fade/40 bg-paper p-5 md:p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="sticky top-0 z-10 float-right ml-4 p-2 rounded-md border border-ink-fade/30 bg-paper/95 text-ink-soft hover:text-ink hover:bg-paper-2"
          aria-label={t('access.cancel')}
        >
          <X className="w-4 h-4" />
        </button>
        <LocalFilesPanel />
      </div>
    </div>
  )
}

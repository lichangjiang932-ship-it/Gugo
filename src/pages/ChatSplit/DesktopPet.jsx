import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cat, X } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'

export default function DesktopPet({ onClose }) {
  const { t, lang } = useT()
  const copy = getSlashActionCopy(lang)
  const [speaking, setSpeaking] = useState(true)
  return (
    <motion.div
      data-testid="desktop-pet"
      initial={{ opacity: 0, scale: 0.72, y: 14 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: 10 }}
      transition={{ type: 'spring', stiffness: 360, damping: 24 }}
      className="fixed bottom-28 right-7 z-40 flex items-end gap-1"
    >
      <AnimatePresence>
        {speaking && (
          <motion.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 6 }} className="mb-3 max-w-48 rounded-2xl rounded-br-sm border border-ink/10 bg-paper px-3 py-2 text-xs text-ink-soft shadow-lg">
            {copy.petGreeting}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.button
        type="button"
        onClick={() => setSpeaking((value) => !value)}
        aria-label={copy.pet[0]}
        title={copy.pet[1]}
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        className="flex h-12 w-12 items-center justify-center rounded-full border border-ink/10 bg-paper text-ink-soft shadow-[0_10px_30px_rgb(var(--color-ink-rgb)/0.16)] hover:text-ink"
      >
        <Cat className="h-6 w-6" strokeWidth={1.7} />
      </motion.button>
      <button type="button" onClick={onClose} aria-label={t('workbench.close')} title={t('workbench.close')} className="mb-8 flex h-5 w-5 items-center justify-center rounded-full bg-ink/70 text-paper shadow-sm hover:bg-ink">
        <X className="h-3 w-3" />
      </button>
    </motion.div>
  )
}

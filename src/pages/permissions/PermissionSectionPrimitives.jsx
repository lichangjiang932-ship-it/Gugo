import { motion } from 'framer-motion'

export function SectionTitle({ eyebrow, title }) {
  return <div className="mb-2 flex items-baseline gap-2"><span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">{eyebrow}</span><span className="font-semibold text-base text-ink-soft">{title}</span></div>
}

export function PermSwitch({ on, onToggle, label }) {
  return <button onClick={onToggle} aria-label={label} className={`relative h-[22px] w-[38px] rounded-full border transition-all duration-200 ${on ? 'border-accent bg-accent' : 'border-ink-fade bg-paper'}`}><motion.div className={`absolute top-[2px] h-4 w-4 rounded-full ${on ? 'left-[18px] bg-paper' : 'left-[2px] bg-ink-fade'}`} layout transition={{ type: 'spring', stiffness: 500, damping: 30 }} /></button>
}

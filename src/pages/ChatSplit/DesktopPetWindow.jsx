import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { readDesktopPetPreferences } from '../../lib/desktopPetPreferences.js'
import { useT } from '../../i18n/I18nProvider.jsx'

const DEFAULT_SPRITE = '/pets/boba/spritesheet.webp'
const STATUS_ROW = { idle: 0, thinking: 7, tool: 6, completed: 4, failed: 5 }
export default function DesktopPetWindow() {
  const { t } = useT()
  const [state, setState] = useState({ visible: true, status: { kind: 'idle', tool: '' } })
  const [preferences, setPreferences] = useState(readDesktopPetPreferences)
  const [frame, setFrame] = useState(0)
  const kind = state.status?.kind || 'idle'

  useEffect(() => {
    window.gugoDesktop?.getPetState().then(setState).catch(() => {})
    return window.gugoDesktop?.onPetState(setState)
  }, [])
  useEffect(() => {
    const refresh = () => setPreferences(readDesktopPetPreferences())
    window.addEventListener('storage', refresh)
    window.addEventListener('gugo:desktop-pet-preferences', refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener('gugo:desktop-pet-preferences', refresh)
    }
  }, [])
  useEffect(() => {
    if (preferences.customImage) return undefined
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % 8), 110)
    return () => window.clearInterval(timer)
  }, [kind, preferences.customImage])

  const statusLabel = kind === 'tool'
    ? t('desktopPet.status.tool', { tool: state.status.tool || t('desktopPet.unknownTool') })
    : t(`desktopPet.status.${kind}`)
  return (
    <main className="pet-window-root" data-status={kind}>
      <section className="pet-window-card">
        <button type="button" className="pet-window-close" aria-label={t('desktopPet.close')} onClick={() => window.gugoDesktop?.hidePet()}><X /></button>
        <div className="pet-window-copy">
          <strong>{statusLabel}</strong>
          <span>{t(`desktopPet.activity.${kind}`)}</span>
        </div>
        {preferences.customImage ? (
          <img className="pet-window-custom" src={preferences.customImage} alt={t('settings.petPreview')} style={{ transform: `scale(${preferences.scale})` }} />
        ) : (
          <span className="pet-window-sprite" style={{ backgroundImage: `url(${DEFAULT_SPRITE})`, backgroundPosition: `-${frame * 73}px -${(STATUS_ROW[kind] || 0) * 79}px`, transform: `scale(${preferences.scale})` }} aria-hidden="true" />
        )}
      </section>
    </main>
  )
}

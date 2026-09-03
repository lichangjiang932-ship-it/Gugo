import { useEffect, useState } from 'react'
import {
  getOutboundNetworkPolicy,
  updateOutboundNetworkPolicy,
} from '../../lib/runtimeConfigClient.js'
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives.jsx'

export default function SettingsNetworkPolicyPanel({ t }) {
  const [policy, setPolicy] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    getOutboundNetworkPolicy().then((next) => {
      if (!active) return
      setPolicy(next)
      setMessage('')
    }).catch((error) => {
      if (active) setMessage(t('settings.pureLocalModeLoadFailed', { message: error?.message || '' }))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [t])

  const update = async (enabled) => {
    setSaving(true)
    setMessage(t('settings.pureLocalModeSaving'))
    try {
      const next = await updateOutboundNetworkPolicy(enabled)
      setPolicy(next)
      setMessage(t(next.pureLocal
        ? 'settings.pureLocalModeEnabled'
        : 'settings.pureLocalModeDisabled'))
    } catch (error) {
      setMessage(t('settings.pureLocalModeUpdateFailed', { message: error?.message || '' }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsGroup
      title={t('settings.networkPrivacy')}
      description={t('settings.networkPrivacyDescription')}
    >
      <SettingsRow
        title={t('settings.pureLocalMode')}
        description={t(policy?.locked
          ? 'settings.pureLocalModeLockedDescription'
          : 'settings.pureLocalModeDescription')}
      >
        <span className="settings-inline-status">
          {t(policy?.pureLocal ? 'settings.pureLocalModeOn' : 'settings.pureLocalModeOff')}
        </span>
        <SettingsToggle
          checked={policy?.pureLocal === true}
          label={t('settings.pureLocalMode')}
          disabled={loading || saving || !policy || policy.locked}
          onChange={(enabled) => void update(enabled)}
        />
      </SettingsRow>
      {message ? <p className="settings-inline-status px-4 py-2" role="status">{message}</p> : null}
    </SettingsGroup>
  )
}

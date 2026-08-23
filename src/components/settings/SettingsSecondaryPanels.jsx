import {
  Check,
  ImagePlus,
  Mic,
  Package,
  Plug,
  RotateCcw,
  Shield,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { readDesktopPetPreferences, validateDesktopPetImage, writeDesktopPetPreferences } from '../../lib/desktopPetPreferences.js'
import {
  listRuntimePluginInventoryApi,
  runtimePluginActionApi,
  runtimePluginPermissionChallenge,
} from '../../lib/pluginClient.js'
import IntegrationsPanel from '../IntegrationsPanel.jsx'
import { LocalPluginPackageManager } from './LocalPluginPackageSettings.jsx'
import { RuntimePluginList } from './RuntimePluginSettings.jsx'
import {
  SettingsGroup,
  SettingsPanel,
  SettingsRow,
  SettingsSegmented,
  SettingsToggle,
} from './SettingsPrimitives.jsx'

const ACCENT_COLORS = ['#E86A3C', '#D94A64', '#B45DE5', '#7459E8', '#3D6FE0', '#2E8FA3', '#23A68B', '#A5C97A', '#D4A4FF', '#D59B32']

export function SettingsPermissionsPanel({ navigate, t, state, enabledPermCount }) {
  return (
    <SettingsPanel title={t('nav.permissions')} description={t('settings.permissionsSubtitle')}>
      <SettingsGroup>
        <SettingsRow title={t('settings.permissionCardTitle')} description={t('settings.permissionCardDescription')}>
          <span className="settings-inline-status">
            {t('settings.permissionsEnabledCount', { enabled: enabledPermCount, total: state.permissions.length })}
          </span>
          <button type="button" onClick={() => navigate('/permissions')} className="settings-action-button">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('settings.openPermissions')}
          </button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.policySummary')} description={t('settings.policySummaryHint')}>
        {state.permissions.map((permission) => {
          const Icon = permission.id === 'mic' ? Mic : Shield
          return (
            <SettingsRow key={permission.id} title={permission.name} description={permission.code}>
              <Icon className="h-3.5 w-3.5 text-ink-fade" aria-hidden="true" />
              <span className={permission.enabled ? 'text-xs text-emerald-600' : 'text-xs text-ink-fade'}>
                {t(permission.enabled ? 'settings.policyAllowed' : 'settings.policyBlocked')}
              </span>
            </SettingsRow>
          )
        })}
      </SettingsGroup>
    </SettingsPanel>
  )
}

export function SettingsAppearancePanel({ t, state, dispatch }) {
  const themeOptions = [
    { value: 'light', label: t('settings.themeLight') },
    { value: 'white', label: t('settings.themeWhite') },
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'system', label: t('settings.themeSystem') },
  ]
  return (
    <SettingsPanel title={t('settings.appearance')} description={t('settings.appearanceSubtitle')}>
      <SettingsGroup>
        <SettingsRow title={t('settings.theme')} description={t('settings.themeDescription')}>
          <SettingsSegmented
            label={t('settings.theme')}
            value={state.theme}
            options={themeOptions}
            onChange={(value) => dispatch({ type: 'SET_THEME', payload: value })}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.accentColor')} description={t('settings.accentColorDescription')} align="start">
          <div className="flex max-w-[260px] flex-wrap justify-end gap-2">
            {ACCENT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => dispatch({ type: 'SET_ACCENT', payload: color })}
                className="relative h-6 w-6 rounded-full"
                style={{ background: color, border: state.accentColor === color ? '2px solid var(--color-ink)' : '1px solid rgb(var(--color-ink-rgb) / 0.16)' }}
                aria-label={t('settings.setAccentColor', { color })}
              >
                {state.accentColor === color ? <Check className="absolute inset-0 m-auto h-3.5 w-3.5 text-accent-contrast" /> : null}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow title={t('settings.strongAccent')} description={t('settings.strongAccentDescription')}>
          <SettingsToggle
            checked={Boolean(state.strongAccent)}
            label={t('settings.strongAccent')}
            onChange={(value) => dispatch({ type: 'SET_STRONG_ACCENT', payload: value })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow title={t('settings.fontSize')} description={t('settings.fontSizeDescription')}>
          <SettingsSegmented
            label={t('settings.fontSize')}
            value={state.fontSize}
            options={[
              { value: 'small', label: t('settings.sizeSmall') },
              { value: 'medium', label: t('settings.sizeMedium') },
              { value: 'large', label: t('settings.sizeLarge') },
            ]}
            onChange={(value) => dispatch({ type: 'SET_FONT_SIZE', payload: value })}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.density')} description={t('settings.densityDescription')}>
          <SettingsSegmented
            label={t('settings.density')}
            value={state.density}
            options={[
              { value: 'compact', label: t('settings.densityCompact') },
              { value: 'comfortable', label: t('settings.densityComfortable') },
              { value: 'loose', label: t('settings.densityLoose') },
            ]}
            onChange={(value) => dispatch({ type: 'SET_DENSITY', payload: value })}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.animations')} description={t('settings.animationsDescription')}>
          <SettingsToggle
            checked={Boolean(state.animationsEnabled)}
            label={t('settings.animations')}
            onChange={(value) => dispatch({ type: 'SET_ANIMATIONS', payload: value })}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.inputHistoryNavigation')} description={t('settings.inputHistoryNavigationDescription')}>
          <SettingsToggle
            checked={state.inputHistoryNavigationEnabled !== false}
            label={t('settings.inputHistoryNavigation')}
            onChange={(value) => dispatch({ type: 'SET_INPUT_HISTORY_NAVIGATION', payload: value })}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPanel>
  )
}

export function SettingsPetPanel({ compact = false, t }) {
  const [preferences, setPreferences] = useState(readDesktopPetPreferences)
  const [message, setMessage] = useState('')

  const update = (next) => {
    const value = { ...preferences, ...next }
    writeDesktopPetPreferences(value)
    setPreferences(value)
  }

  const selectImage = (event) => {
    const file = event.target.files?.[0]
    const error = validateDesktopPetImage(file)
    if (error) {
      setMessage(t(`settings.petImageError.${error}`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      update({ customImage: String(reader.result || '') })
      setMessage(t('settings.petSaved'))
    }
    reader.onerror = () => setMessage(t('settings.petReadFailed'))
    reader.readAsDataURL(file)
  }

  const content = (
    <SettingsGroup title={t('settings.pet')} description={t('settings.petSubtitle')}>
      <SettingsRow title={t('settings.petImage')} description={t('settings.petImageHint')}>
        {preferences.customImage ? (
          <img
            src={preferences.customImage}
            alt={t('settings.petPreview')}
            className="h-8 w-8 rounded object-contain"
            style={{ transform: `scale(${Math.min(preferences.scale, 1.2)})` }}
          />
        ) : <ImagePlus className="h-4 w-4 text-ink-fade" aria-hidden="true" />}
        <label className="settings-action-button cursor-pointer">
          {t('settings.petChoose')}
          <input type="file" accept="image/png,image/webp,image/gif" className="sr-only" onChange={selectImage} />
        </label>
      </SettingsRow>
      <SettingsRow title={t('settings.petSize')} description={`${Math.round(preferences.scale * 100)}%`}>
        <input
          aria-label={t('settings.petSize')}
          type="range"
          min="0.6"
          max="1.8"
          step="0.1"
          value={preferences.scale}
          onChange={(event) => update({ scale: Number(event.target.value) })}
          className="w-36 accent-blue-600"
        />
        <button
          type="button"
          onClick={() => {
            update({ customImage: '', scale: 1 })
            setMessage(t('settings.petResetDone'))
          }}
          className="settings-action-button"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('settings.petReset')}
        </button>
      </SettingsRow>
      {message ? (
        <div className="px-4 py-2 text-xs text-ink-fade" role="status">{message}</div>
      ) : null}
    </SettingsGroup>
  )

  if (compact) return content
  return <SettingsPanel title={t('settings.pet')} description={t('settings.petSubtitle')}>{content}</SettingsPanel>
}

export function SettingsPluginsPanel({ navigate, t }) {
  const [plugins, setPlugins] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const [permissionChallenge, setPermissionChallenge] = useState(null)
  const [actionFailure, setActionFailure] = useState(null)
  const load = useCallback(async () => {
    try {
      const data = await listRuntimePluginInventoryApi()
      setPlugins(Array.isArray(data?.plugins) ? data.plugins : [])
      setError(null)
    } catch (cause) {
      setPlugins([])
      setError(cause)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    listRuntimePluginInventoryApi()
      .then((data) => {
        if (cancelled) return
        setPlugins(Array.isArray(data?.plugins) ? data.plugins : [])
        setError(null)
      })
      .catch((cause) => {
        if (cancelled) return
        setPlugins([])
        setError(cause)
      })
    return () => { cancelled = true }
  }, [])
  const act = useCallback(async (id, action, options = {}) => {
    setBusy(`${id}:${action}`)
    setPermissionChallenge(null)
    setActionFailure(null)
    try {
      await runtimePluginActionApi(id, action, options)
      setPermissionChallenge(null)
      setActionFailure(null)
      setError(null)
      await load()
    } catch (cause) {
      const challenge = runtimePluginPermissionChallenge(cause, { pluginId: id, action })
      if (challenge) {
        setPermissionChallenge(challenge)
        setActionFailure(null)
        setError(null)
      } else {
        setActionFailure({
          pluginId: id,
          action,
          message: String(cause?.message || '').slice(0, 200),
        })
      }
    } finally {
      setBusy('')
    }
  }, [load])
  const approvePermissions = useCallback(() => {
    if (!permissionChallenge) return
    void act(permissionChallenge.pluginId, permissionChallenge.action, {
      approvalDigest: permissionChallenge.approvalDigest,
    })
  }, [act, permissionChallenge])
  return (
    <SettingsPanel title={t('settings.plugins')} description={t('settings.pluginsDescription')}>
      <SettingsGroup>
        <SettingsRow title={t('settings.skillPlugins')} description={t('settings.skillPluginsDescription')}>
          <button type="button" onClick={() => navigate('/skills')} className="settings-action-button">
            <Package className="h-3.5 w-3.5" />
            {t('settings.managePlugins')}
          </button>
        </SettingsRow>
        <SettingsRow title={t('settings.mcpExtensions')} description={t('settings.mcpExtensionsDescription')}>
          <button type="button" onClick={() => navigate('/mcp')} className="settings-action-button">
            <Plug className="h-3.5 w-3.5" />
            {t('settings.manageMcp')}
          </button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <LocalPluginPackageManager t={t} onPackagesChanged={load} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.runtimePlugins')} description={t('settings.runtimePluginsDescription')}>
        <RuntimePluginList
          plugins={plugins}
          error={error}
          busy={busy}
          permissionChallenge={permissionChallenge}
          actionFailure={actionFailure}
          onAction={act}
          onApprove={approvePermissions}
          onDismissApproval={() => setPermissionChallenge(null)}
          t={t}
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}

export function SettingsAgentPresetsPanel({ navigate, t }) {
  return (
    <SettingsPanel title={t('settings.agentPresets')} description={t('settings.agentPresetsDescription')}>
      <SettingsGroup>
        <SettingsRow title={t('settings.agentProfiles')} description={t('settings.agentProfilesDescription')}>
          <button type="button" onClick={() => navigate('/agents')} className="settings-action-button">
            <Users className="h-3.5 w-3.5" />
            {t('settings.manageAgents')}
          </button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPanel>
  )
}

export function SettingsIntegrationsPanel({ navigate, t }) {
  return (
    <SettingsPanel title={t('settings.integrations')} description={t('settings.integrationsSubtitle')}>
      <SettingsGroup>
        <SettingsRow title={t('access.manageInAccess')} description={t('access.manageHint')}>
          <button type="button" onClick={() => navigate('/access')} className="settings-action-button">
            {t('access.manageInAccess')}
          </button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.visionAssist')} description={t('integrations.visionAssistHint')}>
        <div className="p-3"><IntegrationsPanel kind="vision_assist" t={t} /></div>
      </SettingsGroup>
    </SettingsPanel>
  )
}

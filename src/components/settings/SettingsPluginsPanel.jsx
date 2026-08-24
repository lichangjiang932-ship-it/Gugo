import { Package, Plug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  listRuntimePluginInventoryApi,
  runtimePluginActionApi,
  runtimePluginPermissionChallenge,
} from '../../lib/pluginClient.js'
import { LocalPluginPackageManager } from './LocalPluginPackageSettings.jsx'
import { RuntimePluginList } from './RuntimePluginSettings.jsx'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

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

import ModelProvidersPanel from '../ModelProvidersPanel.jsx'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

/**
 * 模型设置页 —— 简洁优先：
 * 去掉手写体标题 / 装饰框 / 入场动画，改成一行紧凑状态条 + Provider 列表。
 * 用户要填模型时看这里就知道「当前用什么、配了几个」，细节全在列表和编辑器里。
 */
export default function SettingsModelsPanel({ diagnostics, onChanged, onReady, t }) {
  const model = diagnostics?.model
  const configured = Boolean(model?.configured)
  return (
    <SettingsPanel title={t('modelProviders.navTitle')} description={t('modelProviders.navSubtitle')}>
      <SettingsGroup>
        <SettingsRow title={t('modelProviders.currentModel')} description={t(configured ? 'modelProviders.statusConfigured' : 'modelProviders.statusWaiting')}>
          <span className={`h-2 w-2 rounded-full ${configured ? 'bg-success' : 'bg-ink-fade'}`} aria-hidden="true" />
          <code className="settings-link-value">{model?.modelName || t('modelProviders.notConfigured')}</code>
        </SettingsRow>
        <SettingsRow title={t('modelProviders.baseUrlLabel')}>
          <code className="settings-link-value">{model?.baseUrlMasked || t('modelProviders.notConfigured')}</code>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('modelProviders.manage')}>
        <div className="p-3"><ModelProvidersPanel onChanged={onChanged} onReady={onReady} /></div>
      </SettingsGroup>
    </SettingsPanel>
  )
}

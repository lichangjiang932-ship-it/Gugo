import {
  SETTINGS_TAB_ABOUT,
  SETTINGS_TAB_AGENT_PRESETS,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_GENERAL,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_PLUGINS,
  SETTINGS_TAB_RECOVERY,
  SETTINGS_TAB_WEB_SEARCH,
} from '../../lib/settingsNavigation.js'

const SETTINGS_NAV_GROUPS = [
  {
    labelKey: 'settings.navGroups.general',
    items: [
      SETTINGS_TAB_GENERAL,
      SETTINGS_TAB_MODELS,
      SETTINGS_TAB_APPEARANCE,
      SETTINGS_TAB_LANGUAGE,
    ],
  },
  {
    labelKey: 'settings.navGroups.capabilities',
    items: [
      SETTINGS_TAB_PLUGINS,
      SETTINGS_TAB_WEB_SEARCH,
      SETTINGS_TAB_PERMISSIONS,
      SETTINGS_TAB_AGENT_PRESETS,
    ],
  },
  {
    labelKey: 'settings.navGroups.system',
    items: [
      SETTINGS_TAB_INTEGRATIONS,
      SETTINGS_TAB_DATA,
      SETTINGS_TAB_RECOVERY,
      SETTINGS_TAB_ABOUT,
    ],
  },
]

function navLabel(item, t) {
  switch (item) {
    case SETTINGS_TAB_GENERAL: return t('settings.general')
    case SETTINGS_TAB_MODELS: return t('modelProviders.navTitle')
    case SETTINGS_TAB_APPEARANCE: return t('settings.appearance')
    case SETTINGS_TAB_LANGUAGE: return t('settings.language')
    case SETTINGS_TAB_PLUGINS: return t('settings.plugins')
    case SETTINGS_TAB_WEB_SEARCH: return t('webSearch.title')
    case SETTINGS_TAB_PERMISSIONS: return t('nav.permissions')
    case SETTINGS_TAB_AGENT_PRESETS: return t('settings.agentPresets')
    case SETTINGS_TAB_INTEGRATIONS: return t('settings.integrations')
    case SETTINGS_TAB_DATA: return t('settings.dataExport')
    case SETTINGS_TAB_RECOVERY: return t('sideEffectRecovery.navTitle')
    case SETTINGS_TAB_ABOUT: return t('settings.about')
    default: return item
  }
}

export default function SettingsDialogNavigation({
  activeSection,
  contributedSettings,
  setActiveSection,
  t,
}) {
  return (
    <aside className="settings-dialog-nav">
      <div className="settings-dialog-brand">{t('settings.sectionTitle')}</div>
      <nav className="settings-nav-groups" aria-label={t('settings.sectionTitle')}>
        {SETTINGS_NAV_GROUPS.map((group) => (
          <section className="settings-nav-group" key={group.labelKey}>
            <h2 className="settings-nav-group-label">{t(group.labelKey)}</h2>
            <div className="settings-nav-group-items">
              {group.items.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-current={activeSection === item ? 'page' : undefined}
                  onClick={() => setActiveSection(item)}
                  className="settings-nav-item"
                >
                  {navLabel(item, t)}
                </button>
              ))}
            </div>
          </section>
        ))}
        {contributedSettings.length > 0 && (
          <section className="settings-nav-group" data-ui-contribution-slot="settings-section">
            <h2 className="settings-nav-group-label">{t('settings.plugins')}</h2>
            <div className="settings-nav-group-items">
              {contributedSettings.map((contribution) => (
                <button
                  key={contribution.key}
                  type="button"
                  aria-current={activeSection === contribution.sectionId ? 'page' : undefined}
                  onClick={() => setActiveSection(contribution.sectionId)}
                  className="settings-nav-item"
                >
                  {contribution.labelKey ? t(contribution.labelKey) : contribution.label}
                </button>
              ))}
            </div>
          </section>
        )}
      </nav>
    </aside>
  )
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsAppearancePanel } from '../../src/components/settings/SettingsSecondaryPanels.jsx'

const labels = {
  'settings.theme': 'Theme',
  'settings.themeDescription': 'Choose a theme.',
  'settings.themeLight': 'Light',
  'settings.themeWhite': 'White',
  'settings.themeDark': 'Dark',
  'settings.themeSystem': 'System',
  'settings.strongAccent': 'Strong accent',
  'settings.strongAccentDescription': 'Strengthen the selected accent.',
  'settings.inputHistoryNavigation': 'Input history navigation',
  'settings.inputHistoryNavigationDescription': 'Browse sent prompts from an empty input.',
}

const t = (key) => labels[key] || key

test('appearance exposes white as a distinct selectable theme', () => {
  const markup = renderToStaticMarkup(
    <SettingsAppearancePanel
      t={t}
      state={{
        theme: 'white',
        accentColor: '#E86A3C',
        strongAccent: false,
        fontSize: 'medium',
        density: 'comfortable',
        animationsEnabled: true,
        inputHistoryNavigationEnabled: false,
      }}
      dispatch={() => {}}
    />,
  )

  for (const label of ['Light', 'White', 'Dark', 'System']) {
    assert.match(markup, new RegExp(`>${label}</button>`))
  }
  assert.match(markup, /aria-pressed="true">White<\/button>/)
  assert.doesNotMatch(markup, /aria-pressed="true">Light<\/button>/)
  assert.doesNotMatch(markup, /Strong accent/)
  assert.match(markup, /role="switch" aria-checked="false" aria-label="Input history navigation"/)
})

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
  // Accent color picker removed: no swatch UI, no accentColor state usage.
  assert.doesNotMatch(markup, /accentColor/)
})

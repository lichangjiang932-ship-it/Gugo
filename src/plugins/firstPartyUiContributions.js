import { lazy } from 'react'
import { Blocks } from 'lucide-react'
import { getUiPlugin, registerTrustedUiPlugin } from './uiContributionRegistry.js'

const McpServersView = lazy(() => import('../pages/McpServersView.jsx'))
const ReasonixWorkspace = lazy(() => import('../pages/ReasonixWorkspace.jsx'))
const SettingsEvolutionPanel = lazy(() => import('../components/settings/SettingsEvolutionPanel.jsx'))

const FIRST_PARTY_UI_MANIFEST = Object.freeze({
  id: 'gugo-first-party',
  name: 'Gugo first-party UI',
  version: '1.0.0',
  contributes: Object.freeze([
    'ui:route:mcp-route',
    'ui:route:reasonix-route',
    'ui:account-menu:mcp-account-menu',
    'ui:settings-section:evolution-settings',
  ]),
})

export function registerFirstPartyUiContributions() {
  if (getUiPlugin(FIRST_PARTY_UI_MANIFEST.id)) return null
  return registerTrustedUiPlugin(FIRST_PARTY_UI_MANIFEST, [
    {
      id: 'mcp-route',
      slot: 'route',
      path: '/mcp',
      component: McpServersView,
      requiresAuth: true,
      order: 100,
    },
    {
      id: 'reasonix-route',
      slot: 'route',
      path: '/reasonix',
      component: ReasonixWorkspace,
      requiresAuth: true,
      order: 110,
    },
    {
      id: 'mcp-account-menu',
      slot: 'account-menu',
      path: '/mcp',
      labelKey: 'nav.mcp',
      icon: Blocks,
      requiresLogin: true,
      order: 100,
    },
    {
      id: 'evolution-settings',
      slot: 'settings-section',
      sectionId: 'evolution',
      labelKey: 'evolution.title',
      component: SettingsEvolutionPanel,
      order: 120,
    },
  ])
}

registerFirstPartyUiContributions()

import { lazy } from 'react'
import { Blocks } from 'lucide-react'
import { listUiContributions, registerUiContributions } from './uiContributionRegistry.js'

const McpServersView = lazy(() => import('../pages/McpServersView.jsx'))
const ReasonixWorkspace = lazy(() => import('../pages/ReasonixWorkspace.jsx'))

export function registerFirstPartyUiContributions() {
  if (listUiContributions('route').some((entry) => entry.pluginId === 'gugo-first-party')) return null
  return registerUiContributions('gugo-first-party', [
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
  ])
}

registerFirstPartyUiContributions()

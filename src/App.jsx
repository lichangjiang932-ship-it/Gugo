import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

import ErrorBoundary from './components/ErrorBoundary'
import { I18nProvider } from './i18n/I18nProvider.jsx'
import { ActiveAgentProvider } from './agents/ActiveAgentProvider.jsx'
import RequireAuth from './components/RequireAuth'
import SessionSearchModal from './components/SessionSearchModal'
import { ToastProvider } from './components/Toast.jsx'
import PreviewBanner from './components/PreviewBanner.jsx'

const CoverPage = lazy(() => import('./pages/CoverPage'))
const ChatSplit = lazy(() => import('./pages/ChatSplit'))
const SkillsMarket = lazy(() => import('./pages/SkillsMarket'))
const PermissionsDashboard = lazy(() => import('./pages/PermissionsDashboard'))
const ApprovalsInbox = lazy(() => import('./pages/ApprovalsInbox'))
const TaskRunPanel = lazy(() => import('./pages/TaskRunPanel'))
const HistoryView = lazy(() => import('./pages/HistoryView'))
const SettingsView = lazy(() => import('./pages/SettingsView'))
const MemoryView = lazy(() => import('./pages/MemoryView'))
const DeskView = lazy(() => import('./pages/DeskView'))
const AgentList = lazy(() => import('./pages/AgentList'))
const McpServersView = lazy(() => import('./pages/McpServersView'))
const ReasonixWorkspace = lazy(() => import('./pages/ReasonixWorkspace'))
const ChannelsPage = lazy(() => import('./pages/ChannelsPage'))
const AccessView = lazy(() => import('./pages/AccessView'))

function Fallback() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-stone-400" role="status" aria-label="页面加载中">
      <div className="w-8 h-8 rounded-full border-2 border-ember/30 border-t-ember animate-spin" />
      <span className="text-sm tracking-wide">加载中…</span>
    </div>
  )
}

function App() {
  return (
    <I18nProvider>
    <ToastProvider>
    <ActiveAgentProvider>
    <ErrorBoundary>
      <SessionSearchModal />
      <Suspense fallback={<Fallback />}>
        <main>
          <PreviewBanner />
          <Routes>
          <Route path="/" element={<CoverPage />} />
          <Route path="/chat" element={<ChatSplit />} />
          <Route path="/skills" element={<SkillsMarket />} />
          <Route path="/permissions" element={<PermissionsDashboard />} />
          <Route path="/approvals" element={<RequireAuth><ApprovalsInbox /></RequireAuth>} />
          <Route path="/task" element={<TaskRunPanel />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/settings" element={<RequireAuth><SettingsView /></RequireAuth>} />
          <Route path="/memory" element={<RequireAuth><MemoryView /></RequireAuth>} />
          <Route path="/desk" element={<RequireAuth><DeskView /></RequireAuth>} />
          <Route path="/agents" element={<RequireAuth><AgentList /></RequireAuth>} />
          <Route path="/channels" element={<RequireAuth><ChannelsPage /></RequireAuth>} />
          <Route path="/access" element={<RequireAuth><AccessView /></RequireAuth>} />
          <Route path="/mcp" element={<RequireAuth><McpServersView /></RequireAuth>} />
          <Route path="/reasonix" element={<RequireAuth><ReasonixWorkspace /></RequireAuth>} />

          <Route path="/login" element={<Navigate to="/chat" replace />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
        </main>
      </Suspense>
    </ErrorBoundary>
    </ActiveAgentProvider>
    </ToastProvider>
    </I18nProvider>
  )
}

export default App

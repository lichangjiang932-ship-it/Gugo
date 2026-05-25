import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

import GlobalShortcuts from './components/GlobalShortcuts'
import ErrorBoundary from './components/ErrorBoundary'
import { I18nProvider } from './i18n/I18nProvider.jsx'
import CommandPalette from './components/CommandPalette'
import SkillCommandsSync from './components/SkillCommandsSync'
import RequireAuth from './components/RequireAuth'

const CoverPage = lazy(() => import('./pages/CoverPage'))
const ChatSplit = lazy(() => import('./pages/ChatSplit'))
const SkillsMarket = lazy(() => import('./pages/SkillsMarket'))
const PermissionsDashboard = lazy(() => import('./pages/PermissionsDashboard'))
const TaskRunPanel = lazy(() => import('./pages/TaskRunPanel'))
const HistoryView = lazy(() => import('./pages/HistoryView'))
const SettingsView = lazy(() => import('./pages/SettingsView'))
const MemoryView = lazy(() => import('./pages/MemoryView'))
const HooksView = lazy(() => import('./pages/HooksView'))
const McpServersView = lazy(() => import('./pages/McpServersView'))
const ReasonixWorkspace = lazy(() => import('./pages/ReasonixWorkspace'))

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
    <ErrorBoundary>
      <GlobalShortcuts />
      <CommandPalette />
      <SkillCommandsSync />
      <Suspense fallback={<Fallback />}>
        <main>
          <Routes>
          <Route path="/" element={<CoverPage />} />
          <Route path="/chat" element={<ChatSplit />} />
          <Route path="/skills" element={<SkillsMarket />} />
          <Route path="/permissions" element={<PermissionsDashboard />} />
          <Route path="/task" element={<TaskRunPanel />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/settings" element={<RequireAuth><SettingsView /></RequireAuth>} />
          <Route path="/memory" element={<RequireAuth><MemoryView /></RequireAuth>} />
          <Route path="/hooks" element={<RequireAuth><HooksView /></RequireAuth>} />
          <Route path="/mcp" element={<RequireAuth><McpServersView /></RequireAuth>} />
          <Route path="/reasonix" element={<RequireAuth><ReasonixWorkspace /></RequireAuth>} />

          <Route path="/login" element={<Navigate to="/chat" replace />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
        </main>
      </Suspense>
    </ErrorBoundary>
    </I18nProvider>
  )
}

export default App

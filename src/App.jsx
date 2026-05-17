import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

import GlobalShortcuts from './components/GlobalShortcuts'
import ErrorBoundary from './components/ErrorBoundary'

const ChatSplit = lazy(() => import('./pages/ChatSplit'))
const SkillsMarket = lazy(() => import('./pages/SkillsMarket'))
const PermissionsDashboard = lazy(() => import('./pages/PermissionsDashboard'))
const TaskRunPanel = lazy(() => import('./pages/TaskRunPanel'))
const HistoryView = lazy(() => import('./pages/HistoryView'))
const SettingsView = lazy(() => import('./pages/SettingsView'))
const ReasonixWorkspace = lazy(() => import('./pages/ReasonixWorkspace'))

function Fallback() {
  return (
    <div className="min-h-screen flex items-center justify-center text-stone-400 text-sm">
      加载中...
    </div>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <GlobalShortcuts />
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatSplit />} />
          <Route path="/skills" element={<SkillsMarket />} />
          <Route path="/permissions" element={<PermissionsDashboard />} />
          <Route path="/task" element={<TaskRunPanel />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/reasonix" element={<ReasonixWorkspace />} />

          <Route path="/login" element={<Navigate to="/chat" replace />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

export default App

import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

import GlobalShortcuts from './components/GlobalShortcuts'
import ErrorBoundary from './components/ErrorBoundary'
import CommandPalette from './components/CommandPalette'
import SkillCommandsSync from './components/SkillCommandsSync'

const ChatSplit = lazy(() => import('./pages/ChatSplit'))
const SkillsMarket = lazy(() => import('./pages/SkillsMarket'))
const PermissionsDashboard = lazy(() => import('./pages/PermissionsDashboard'))
const TaskRunPanel = lazy(() => import('./pages/TaskRunPanel'))
const HistoryView = lazy(() => import('./pages/HistoryView'))
const SettingsView = lazy(() => import('./pages/SettingsView'))
const MemoryView = lazy(() => import('./pages/MemoryView'))
const HooksView = lazy(() => import('./pages/HooksView'))
const McpServersView = lazy(() => import('./pages/McpServersView'))

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
      <CommandPalette />
      <SkillCommandsSync />
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatSplit />} />
          <Route path="/skills" element={<SkillsMarket />} />
          <Route path="/permissions" element={<PermissionsDashboard />} />
          <Route path="/task" element={<TaskRunPanel />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/memory" element={<MemoryView />} />
          <Route path="/hooks" element={<HooksView />} />
          <Route path="/mcp" element={<McpServersView />} />

          <Route path="/login" element={<Navigate to="/chat" replace />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

export default App

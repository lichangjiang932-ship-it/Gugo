/**
 * 路由守卫 — 未登录用户访问受保护页面时重定向到 /chat。
 */

import { Navigate } from 'react-router-dom'
import { useAppContext } from '../store/AppContext'

export default function RequireAuth({ children }) {
  const { state } = useAppContext()
  if (!state.isLoggedIn) {
    return <Navigate to="/chat" replace />
  }
  return children
}

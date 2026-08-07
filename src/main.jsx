import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from './lib/router.jsx'
import { AppProvider } from './store/AppContext.jsx'
import ThemeWrapper from './components/ThemeWrapper.jsx'
import './index.css'
import App from './App.jsx'
import DesktopPetWindow from './pages/ChatSplit/DesktopPetWindow.jsx'
import { I18nProvider } from './i18n/I18nProvider.jsx'

const isDesktopPetWindow = new URLSearchParams(window.location.search).get('gugoPet') === '1'

createRoot(document.getElementById('root')).render(isDesktopPetWindow ? (
  <StrictMode><I18nProvider><DesktopPetWindow /></I18nProvider></StrictMode>
) : (
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <ThemeWrapper>
          <App />
        </ThemeWrapper>
      </AppProvider>
    </HashRouter>
  </StrictMode>
))

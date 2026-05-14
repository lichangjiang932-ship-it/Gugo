import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AppProvider } from './store/AppContext.jsx'
import ThemeWrapper from './components/ThemeWrapper.jsx'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <ThemeWrapper>
          <App />
        </ThemeWrapper>
      </AppProvider>
    </HashRouter>
  </StrictMode>,
)

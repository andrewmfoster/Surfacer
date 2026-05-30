import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import TrayApp from './TrayApp.jsx'
import OverlayApp from './OverlayApp.jsx'

const params = new URLSearchParams(window.location.search)
const isTray = params.has('tray')
const isOverlay = params.has('overlay')

function Root() {
  if (isOverlay) return <OverlayApp />
  if (isTray) return <TrayApp />
  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

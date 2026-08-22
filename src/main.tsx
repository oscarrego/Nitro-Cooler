import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import NitroApp from './NitroApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NitroApp />
  </StrictMode>,
)

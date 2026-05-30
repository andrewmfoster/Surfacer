import { motion, AnimatePresence } from 'framer-motion'
import { LayoutGrid, Camera, AppWindow, X } from 'lucide-react'
import './WelcomeCard.css'

export default function WelcomeCard({ visible, onDismiss }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="welcome-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          onClick={onDismiss}
        >
          <motion.div
            className="welcome-card"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="welcome-dismiss" onClick={onDismiss} aria-label="Dismiss">
              <X size={14} strokeWidth={1.75} />
            </button>

            <h2 className="welcome-title">Welcome to Surfacer</h2>
            <p className="welcome-subtitle">A few quick things before you start.</p>

            <div className="welcome-rows">
              <div className="welcome-row">
                <div className="welcome-icon"><LayoutGrid size={18} strokeWidth={1.5} /></div>
                <div>
                  <div className="welcome-row-title">Add a project</div>
                  <div className="welcome-row-body">Click <em>+ New project</em> in the sidebar to start a column.</div>
                </div>
              </div>

              <div className="welcome-row">
                <div className="welcome-icon"><Camera size={18} strokeWidth={1.5} /></div>
                <div>
                  <div className="welcome-row-title">Screenshots route to projects</div>
                  <div className="welcome-row-body">
                    Take a screenshot anywhere (<kbd>⌘⇧4</kbd>) and Surfacer will offer to send it to a project. Click <em>Allow</em> when macOS asks for Desktop access.
                  </div>
                </div>
              </div>

              <div className="welcome-row">
                <div className="welcome-icon"><AppWindow size={18} strokeWidth={1.5} /></div>
                <div>
                  <div className="welcome-row-title">Menu bar quick-add</div>
                  <div className="welcome-row-body">
                    Click the <span className="welcome-su">Su</span> icon in your menu bar to add cards from any app, on any desktop.
                  </div>
                </div>
              </div>
            </div>

            <button className="welcome-cta" onClick={onDismiss}>Got it</button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

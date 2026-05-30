import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { STATUS_COLORS } from './status'
import './OverlayApp.css'

const STATUS_ORDER = { active: 0, paused: 1, idea: 2, shipped: 3 }
const DISMISS_SECS = 8

export default function OverlayApp() {
  const [thumbDataUrl, setThumbDataUrl] = useState('')
  const [projects, setProjects] = useState([])
  const [secsLeft, setSecsLeft] = useState(DISMISS_SECS)
  // Once the user has hovered the project list (or chosen an action), the
  // countdown is gone for this capture — they're engaging with the overlay
  // deliberately and the auto-dismiss timer becomes a distraction.
  const [countdownActive, setCountdownActive] = useState(true)
  // Guards against double-fire: route+dismiss both call hide_overlay in
  // Rust, but we also defensively block a second click on the React side
  // since the window may take a tick to actually hide.
  const doneRef = useRef(false)

  useEffect(() => {
    let unlisten = () => {}
    let cancelled = false
    listen('overlay-data', ({ payload }) => {
      // Reset state for the new capture — the window is persistent and
      // reused across screenshots, so internal state from the previous
      // capture would otherwise leak through.
      setThumbDataUrl(payload?.thumbDataUrl || '')
      setProjects(Array.isArray(payload?.projects) ? payload.projects : [])
      setSecsLeft(DISMISS_SECS)
      setCountdownActive(true)
      doneRef.current = false
    }).then(fn => {
      if (cancelled) { fn(); return }
      unlisten = fn
    })
    return () => { cancelled = true; unlisten() }
  }, [])

  // Countdown timer — ticks once per second when active; auto-dismisses at zero.
  useEffect(() => {
    if (!countdownActive) return
    if (secsLeft <= 0) {
      handleDismiss()
      return
    }
    const t = setTimeout(() => setSecsLeft(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [secsLeft, countdownActive])

  async function handleDismiss() {
    if (doneRef.current) return
    doneRef.current = true
    setCountdownActive(false)
    try {
      await invoke('overlay_dismiss')
    } catch (e) {
      console.error('overlay_dismiss failed:', e)
    }
  }

  async function handleRoute(projectId) {
    if (doneRef.current) return
    doneRef.current = true
    setCountdownActive(false)
    try {
      await invoke('overlay_route', { projectId })
    } catch (e) {
      console.error('overlay_route failed:', e)
    }
  }

  const sortedProjects = [...projects].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4),
  )

  const progressPct = (secsLeft / DISMISS_SECS) * 100

  return (
    <div id="overlay-root">
      <div id="overlay-card">
        <div id="overlay-header" data-tauri-drag-region>
          <svg
            className="overlay-header-icon"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            data-tauri-drag-region
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span id="overlay-header-label" data-tauri-drag-region>Screenshot captured</span>
          <button id="overlay-dismiss-btn" onClick={handleDismiss} title="Dismiss">
            ✕
          </button>
        </div>

        <div id="overlay-thumb-wrap">
          {thumbDataUrl && <img id="overlay-thumb" src={thumbDataUrl} alt="screenshot" />}
        </div>

        <div id="overlay-route-label">Route to project</div>

        <div
          id="overlay-projects"
          onMouseEnter={() => setCountdownActive(false)}
        >
          {sortedProjects.map(p => (
            <button
              key={p.id}
              className="overlay-project-btn"
              onClick={() => handleRoute(p.id)}
            >
              <span
                className="overlay-status-dot"
                style={{ background: STATUS_COLORS[p.status] || '#666' }}
              />
              <span className="overlay-project-name">{p.title}</span>
              <span className="overlay-project-status">{p.status}</span>
            </button>
          ))}
        </div>

        {countdownActive && (
          <div id="overlay-footer">
            <div id="overlay-progress-track">
              <div id="overlay-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div id="overlay-countdown-text">
              dismissing in <span>{secsLeft}</span>s
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

export default function SettingsModal({ onClose }) {
  const [settings, setSettings] = useState(null)
  const [screenshotsDir, setScreenshotsDir] = useState('')
  const closeBtnRef = useRef(null)

  useEffect(() => {
    let mounted = true
    Promise.all([
      invoke('get_settings'),
      invoke('get_screenshots_dir'),
    ]).then(([s, dir]) => {
      if (!mounted) return
      setSettings(s)
      setScreenshotsDir(dir || '')
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // `inert` makes the underlying app non-focusable + non-interactive so Tab stays
  // within the modal. SettingsModal is portal'd below so .app is a sibling — safe to inert.
  useEffect(() => {
    const app = document.querySelector('.app')
    if (app) app.inert = true
    closeBtnRef.current?.focus()
    return () => { if (app) app.inert = false }
  }, [])

  const update = async (key, value) => {
    const next = await invoke('set_setting', { key, value })
    setSettings(next)
  }

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  if (!settings) return null

  return createPortal(
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="modal modal--settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-corner-btns">
          <button ref={closeBtnRef} className="modal-close" onClick={onClose} title="Close" aria-label="Close">
            <X size={14} strokeWidth={1.7} />
          </button>
        </div>

        <div className="settings-header">
          <h2 className="settings-title">Settings</h2>
        </div>

        <div className="settings-body">
          <Section title="Screenshots">
            <Row label="Screenshots folder" hint={screenshotsDir || 'No folder set'}>
              <button className="settings-btn" onClick={() => invoke('open_screenshots_dir')}>
                Open
              </button>
              <button className="settings-btn" onClick={async () => {
                const dir = await invoke('pick_screenshots_dir')
                if (dir) setScreenshotsDir(dir)
              }}>
                Change…
              </button>
            </Row>
            <Toggle
              label="Screenshot overlay"
              hint="Show the project picker when a new screenshot is captured."
              value={settings.screenshotOverlay}
              onChange={(v) => update('screenshotOverlay', v)}
            />
            <Toggle
              label="Copy to Desktop on dismiss"
              hint="When you dismiss the overlay, the screenshot is copied to your Desktop."
              value={settings.copyToDesktopOnDismiss}
              onChange={(v) => update('copyToDesktopOnDismiss', v)}
            />
          </Section>

          <Section title="App">
            <Toggle
              label="Menu bar icon"
              hint="Show the Surfacer icon in the macOS menu bar."
              value={settings.trayIcon}
              onChange={(v) => update('trayIcon', v)}
            />
            <Toggle
              label="Start at login"
              hint="Launch Surfacer automatically when you log in."
              value={settings.startAtLogin}
              onChange={(v) => update('startAtLogin', v)}
            />
          </Section>

          <Section title="Data">
            <Row label="Database" hint="Surfacer keeps everything locally — back it up.">
              <button className="settings-btn" onClick={() => invoke('reveal_db')}>
                Reveal in Finder
              </button>
              <button className="settings-btn" onClick={() => invoke('export_db')}>
                Save backup…
              </button>
            </Row>
            <NumberRow
              label="Auto-purge after"
              hint="Trashed cards are permanently deleted after this many days. Takes effect on next purge sweep."
              value={settings.autoPurgeDays}
              unit="days"
              min={1}
              max={365}
              onCommit={(v) => update('autoPurgeDays', v)}
            />
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Section({ title, children }) {
  return (
    <div className="settings-section">
      <div className="settings-section-title">{title}</div>
      {children}
    </div>
  )
}

function Row({ label, hint, children }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-actions">{children}</div>
    </div>
  )
}

function Toggle({ label, hint, value, onChange }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={`settings-switch${value ? ' settings-switch--on' : ''}`}
        onClick={() => onChange(!value)}
      >
        <span className="settings-switch-thumb" />
      </button>
    </div>
  )
}

function NumberRow({ label, hint, value, unit, min, max, onCommit }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])

  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) { setDraft(String(value)); return }
    const clamped = Math.max(min, Math.min(max, Math.round(n)))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-actions">
        <input
          className="settings-number"
          type="number"
          min={min}
          max={max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
        <span className="settings-unit">{unit}</span>
      </div>
    </div>
  )
}

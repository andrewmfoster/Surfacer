import { useState, useEffect, useRef } from 'react'
import { Trash2, ScrollText, LayoutGrid, Settings } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { useBoard } from './hooks/useBoard'
import Board from './components/Board'
import TrashView from './components/TrashView'
import BulletinBoard from './components/BulletinBoard'
import ProjectModal from './components/ProjectModal'
import SettingsModal from './components/SettingsModal'
import WelcomeCard from './components/WelcomeCard'
import MeshGradient from './components/MeshGradient'
import { tagColor } from './components/Column'
import { STATUS_COLORS, STATUS_LABELS } from './status'
import './App.css'

const STATUSES = ['active', 'idea', 'paused', 'shipped']

export default function App() {
  const board = useBoard()
  const [activeStatuses, setActiveStatuses] = useState(new Set())
  const [activeTagIds, setActiveTagIds] = useState(new Set())
  const [view, setView] = useState(() => localStorage.getItem('surfacer-view') || 'board')

  const setViewPersisted = (v) => {
    const next = typeof v === 'function' ? v(view) : v
    localStorage.setItem('surfacer-view', next)
    setView(next)
  }
  const [openProjectId, setOpenProjectId] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [welcomeDismissed, setWelcomeDismissed] = useState(
    () => localStorage.getItem('surfacer:welcome-dismissed') === '1'
  )
  const forceWelcome = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('welcome')
  const showWelcome = forceWelcome ||
    (!welcomeDismissed && !board.loading && board.projects.length === 0)
  const dismissWelcome = () => {
    localStorage.setItem('surfacer:welcome-dismissed', '1')
    setWelcomeDismissed(true)
  }

  const undoRef = useRef(board.undo)
  useEffect(() => { undoRef.current = board.undo }, [board.undo])

  useEffect(() => {
    let unlisten = () => {}
    let cancelled = false
    listen('focus-project', (event) => {
      const id = event.payload
      // 150ms lets the board layout settle (status filters, columns) before
      // we scroll.
      setTimeout(() => {
        document.querySelector(`[data-project-id="${id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
      }, 150)
    }).then((fn) => {
      if (cancelled) { fn(); return }
      unlisten = fn
    })
    return () => { cancelled = true; unlisten() }
  }, [])

  useEffect(() => {
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z' || e.shiftKey) return
      const active = document.activeElement
      if (active?.closest?.('[contenteditable="true"]')) return
      if (['INPUT', 'TEXTAREA'].includes(active?.tagName)) return
      e.preventDefault()
      undoRef.current()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const toggleStatus = (status) => {
    setActiveStatuses(prev => {
      const next = new Set(prev)
      next.has(status) ? next.delete(status) : next.add(status)
      return next
    })
  }

  const toggleTagId = (tagId) => {
    setActiveTagIds(prev => {
      const next = new Set(prev)
      next.has(tagId) ? next.delete(tagId) : next.add(tagId)
      return next
    })
  }

  const filteredProjects = board.projects.filter(p => {
    if (activeStatuses.size > 0 && !activeStatuses.has(p.status)) return false
    if (activeTagIds.size > 0 && !p.tags.some(t => activeTagIds.has(t.id))) return false
    return true
  })

  const hasFilters = activeStatuses.size > 0 || activeTagIds.size > 0
  const trashCount = board.trashedProjects.length

  return (
    <>
    <MeshGradient />
    <div className="app">
      <aside className="app-sidebar">
        <div className="sidebar-head" data-tauri-drag-region>
          <div className="sidebar-brand" data-tauri-drag-region>
            <svg className="sidebar-wordmark" viewBox="0 0 172 40" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="wm-glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="3.5"/>
                </filter>
                <radialGradient id="wm-bg" cx="50%" cy="50%" r="60%">
                  <stop offset="0%" stopColor="#4a82d8" stopOpacity="0.13"/>
                  <stop offset="100%" stopColor="#4a82d8" stopOpacity="0"/>
                </radialGradient>
              </defs>
              <rect width="172" height="40" fill="url(#wm-bg)"/>
              <line x1="0" y1="39.5" x2="172" y2="39.5" stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>
              <text x="8" y="13" fill="#4a82d8" fillOpacity="0.55" fontFamily="system-ui, sans-serif" fontSize="8" fontWeight="700">14</text>
              <text x="86" y="27" textAnchor="middle" fill="#4a82d8" fillOpacity="0.85" fontFamily="Plus Jakarta Sans, sans-serif" fontSize="13" fontWeight="800" letterSpacing="0.12em" filter="url(#wm-glow)">Surfacer</text>
              <text x="86" y="27" textAnchor="middle" fill="white" fontFamily="Plus Jakarta Sans, sans-serif" fontSize="13" fontWeight="800" letterSpacing="0.12em">Surfacer</text>
            </svg>
          </div>
        </div>

        <div className="sidebar-view-toggle">
          <button
            className={`sidebar-view-btn${view !== 'trash' && view !== 'bulletin' ? ' sidebar-view-btn--on' : ''}`}
            onClick={() => setViewPersisted('board')}
            title="Scroll view"
            aria-label="Scroll view"
          >
            <ScrollText size={13} strokeWidth={1.8} />
          </button>
          <button
            className={`sidebar-view-btn${view === 'bulletin' ? ' sidebar-view-btn--on' : ''}`}
            onClick={() => setViewPersisted('bulletin')}
            title="Bulletin view"
            aria-label="Bulletin view"
          >
            <LayoutGrid size={13} strokeWidth={1.8} />
          </button>
        </div>

        {hasFilters && (
          <div className="sidebar-filter-bar">
            <button
              className="sidebar-clear-pill"
              onClick={() => { setActiveStatuses(new Set()); setActiveTagIds(new Set()) }}
            >
              Clear filters
            </button>
          </div>
        )}

        <div className="sidebar-status-grid">
          {STATUSES.map(s => {
            const count = board.projects.filter(p => (p.status ?? 'active') === s).length
            return (
              <button
                key={s}
                className={`sidebar-status-tile${activeStatuses.has(s) ? ' sidebar-status-tile--on' : ''}`}
                style={{ '--sc': STATUS_COLORS[s] }}
                onClick={() => { toggleStatus(s); setViewPersisted(v => v === 'trash' ? 'board' : v) }}
              >
                <span className="sidebar-tile-count">{count}</span>
                <span className="sidebar-tile-label">{STATUS_LABELS[s]}</span>
              </button>
            )
          })}
        </div>

        {board.tags.length > 0 && (
          <div className="sidebar-tags">
            <span className="sidebar-section-label">Tags</span>
            {board.tags.map(tag => {
              const count = board.projects.filter(p => p.tags?.some(t => t.id === tag.id)).length
              return (
                <button
                  key={tag.id}
                  className={`sidebar-tag-row${activeTagIds.has(tag.id) ? ' sidebar-tag-row--on' : ''}`}
                  onClick={() => { toggleTagId(tag.id); setViewPersisted(v => v === 'trash' ? 'board' : v) }}
                >
                  <span className="sidebar-tag-dot" style={{ background: tagColor(tag.id) }} />
                  <span className="sidebar-tag-name">{tag.name}</span>
                  <span className="sidebar-tag-count">{count}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="sidebar-footer">
          <button className="sidebar-new-btn" onClick={board.addProject}>
            + New Project
          </button>
          <button
            className="sidebar-settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={15} strokeWidth={1.5} />
          </button>
          <button
            className={`sidebar-trash-btn${view === 'trash' ? ' sidebar-trash-btn--active' : ''}`}
            onClick={() => setViewPersisted(v => v === 'trash' ? 'board' : 'trash')}
            title={`Trash${trashCount > 0 ? ` (${trashCount})` : ''}`}
            aria-label={`Trash${trashCount > 0 ? ` (${trashCount})` : ''}`}
          >
            <Trash2 size={15} strokeWidth={1.5} />
            {trashCount > 0 && <span className="sidebar-trash-badge">{trashCount}</span>}
          </button>
        </div>
      </aside>

      {board.loading ? (
        <div className="board-loading">Loading…</div>
      ) : view === 'trash' ? (
        <TrashView
          trashedProjects={board.trashedProjects ?? []}
          onRestore={board.restoreProject}
          onDelete={board.deleteProject}
        />
      ) : view === 'bulletin' ? (
        <BulletinBoard
          projects={filteredProjects}
          onOpen={setOpenProjectId}
          onTrash={board.trashProject}
          onReorder={board.reorderProjects}
          reorderDisabled={hasFilters}
        />
      ) : (
        <Board {...board} projects={filteredProjects} reorderDisabled={hasFilters} />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {openProjectId && (() => {
        const openProject = board.projects.find(p => p.id === openProjectId)
        return openProject ? (
          <ProjectModal
            project={openProject}
            tags={board.tags}
            onClose={() => setOpenProjectId(null)}
            updateProject={board.updateProject}
            addCard={board.addCard}
            addImageCard={board.addImageCard}
            updateCard={board.updateCard}
            deleteCard={board.deleteCard}
            restoreCard={board.restoreCard}
            hardDeleteCard={board.hardDeleteCard}
            reorderCards={board.reorderCards}
            toggleCardComplete={board.toggleCardComplete}
            setProjectStatus={board.setProjectStatus}
            setProjectTags={board.setProjectTags}
            createTag={board.createTag}
            deleteTag={board.deleteTag}
          />
        ) : null
      })()}

      <WelcomeCard visible={showWelcome} onDismiss={dismissWelcome} />
    </div>
    </>
  )
}

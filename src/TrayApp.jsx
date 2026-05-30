import { useState, useEffect, useRef, useCallback } from 'react'
import { Check, X, Plus, ExternalLink, Power, FolderPlus } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { api } from './api'
import { useUploadsDir } from './hooks/useUploadsDir'
import { STATUS_COLORS, PROJECT_PALETTE } from './status'
import { plainText, toHtml } from './textUtils'
import './TrayApp.css'

export default function TrayApp() {
  const uploadsDir = useUploadsDir()
  const [projects, setProjects] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [newText, setNewText] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [addingProject, setAddingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const inputRef = useRef(null)
  const newProjectInputRef = useRef(null)
  const skipSaveRef = useRef(false)
  const skipProjectSaveRef = useRef(false)

  const selectedProject = projects?.find(p => p.id === selectedId)
  const statusColor = STATUS_COLORS[selectedProject?.status ?? 'active']
  // Filter on `deleted` (the schema's source-of-truth flag), not `deleted_at`
  // (an auxiliary timestamp). They're kept in lockstep by trash/restore today,
  // but the main board keys off `deleted`, so the tray should too. `deleted` is
  // a SQLite 0/1 int — `!0 === true` keeps live cards, `!1 === false` hides.
  const cards = selectedProject?.cards?.filter(c => !c.deleted && !c.completed) ?? []

  const load = useCallback(async () => {
    const data = await api.getBoard()
    setProjects(data)
    setSelectedId(prev => {
      if (prev && data.some(p => p.id === prev)) return prev
      return data[0]?.id ?? null
    })
  }, [])

  useEffect(() => { load() }, [load])

  // Live sync via Tauri's in-process event bus.
  useEffect(() => {
    let unlisten = () => {}
    let cancelled = false
    listen('board-changed', () => load()).then((fn) => {
      if (cancelled) { fn(); return }
      unlisten = fn
    })
    return () => { cancelled = true; unlisten() }
  }, [load])

  // Refocus input when switching projects
  useEffect(() => {
    inputRef.current?.focus()
  }, [selectedId])

  async function handleAddCard() {
    const text = newText.trim()
    if (!text || !selectedId) return
    setNewText('')
    await api.saveCard({
      id: crypto.randomUUID(),
      project_id: selectedId,
      text: toHtml(text),
      icon: 'FileText',
      sort_order: Date.now(),
    })
    await load()
    inputRef.current?.focus()
  }

  async function handleToggleComplete(card) {
    await api.completeCard(card.id, !card.completed)
    await load()
  }

  async function handleDeleteCard(id) {
    await api.softDeleteCard(id)
    await load()
  }

  function startEdit(card) {
    setEditingId(card.id)
    setEditText(plainText(card.text))
  }

  function cancelEdit() {
    skipSaveRef.current = true
    setEditingId(null)
    setEditText('')
  }

  async function saveEdit(card) {
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    const text = editText.trim()
    setEditingId(null)
    setEditText('')
    if (text && text !== plainText(card.text)) {
      // Send a command-shaped payload, not the spread DB row: the serialized
      // card carries `completed` as an int (0/1), but save_card's CardInput
      // expects Option<bool> and serde rejects int→bool, failing the whole
      // call. Mirrors the clean payloads useBoard builds.
      await api.saveCard({
        id: card.id,
        project_id: card.project_id,
        text: toHtml(text),
        icon: card.icon,
        sort_order: card.sort_order ?? 0,
      })
      await load()
    }
  }

  function startAddProject() {
    setNewProjectName('')
    setAddingProject(true)
  }

  function cancelAddProject() {
    skipProjectSaveRef.current = true
    setAddingProject(false)
    setNewProjectName('')
  }

  async function saveNewProject() {
    if (skipProjectSaveRef.current) {
      skipProjectSaveRef.current = false
      return
    }
    const title = newProjectName.trim()
    setAddingProject(false)
    setNewProjectName('')
    if (!title) return
    const id = crypto.randomUUID()
    const len = projects?.length ?? 0
    const color = PROJECT_PALETTE[len % PROJECT_PALETTE.length]
    await api.saveProject({
      id, title, description: '', color, status: 'active',
      sort_order: len === 0 ? 0 : -Date.now(),
    })
    await load()
    setSelectedId(id)
  }

  function handleOpenProject() {
    if (!selectedId) return
    invoke('open_project_in_main', { id: selectedId })
  }

  function handleClose() {
    invoke('close_tray')
  }

  return (
    <div className="tray-root">
      <div className="tray-arrow" />
      <div className="tray-panel">
        <aside className="tray-sidebar">
          {projects === null ? (
            <div className="tray-loading">…</div>
          ) : (
            <>
              {projects.map(p => (
                <button
                  key={p.id}
                  className={`tray-proj-item${p.id === selectedId ? ' selected' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span
                    className="tray-proj-dot"
                    style={{ background: STATUS_COLORS[p.status] }}
                  />
                  <span className="tray-proj-name">{p.title}</span>
                </button>
              ))}
              {addingProject ? (
                <div className="tray-proj-item adding">
                  <span
                    className="tray-proj-dot"
                    style={{ background: STATUS_COLORS.active }}
                  />
                  <input
                    ref={newProjectInputRef}
                    className="tray-proj-new-input"
                    value={newProjectName}
                    autoFocus
                    placeholder="Project name"
                    onChange={e => setNewProjectName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                      if (e.key === 'Escape') { e.preventDefault(); cancelAddProject() }
                    }}
                    onBlur={saveNewProject}
                  />
                </div>
              ) : (
                <button className="tray-proj-item new" onClick={startAddProject}>
                  <FolderPlus size={11} className="tray-proj-new-icon" />
                  <span className="tray-proj-name">New project</span>
                </button>
              )}
            </>
          )}
        </aside>

        <div className="tray-content">
          <div className="tray-content-header">
            <span className="tray-content-title" style={{ color: statusColor }}>
              {selectedProject?.title ?? '—'}
            </span>
            <button className="tray-close-btn" onClick={handleClose}>
              <X size={13} strokeWidth={2} />
            </button>
          </div>

          <div className="tray-add-row">
            <Plus size={13} className="tray-add-icon" />
            <input
              ref={inputRef}
              className="tray-add-input"
              placeholder="Add a card…"
              value={newText}
              onChange={e => setNewText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddCard() }}
              autoFocus
            />
          </div>

          <div className="tray-cards">
            {cards.length === 0 ? (
              <div className="tray-empty">No cards yet</div>
            ) : (
              cards.map(card => (
                <div key={card.id} className={`tray-card${card.completed ? ' done' : ''}`}>
                  <button
                    className="tray-check"
                    onClick={() => handleToggleComplete(card)}
                    style={card.completed ? {
                      borderColor: statusColor,
                      background: statusColor + '28',
                    } : {}}
                  >
                    {card.completed ? <Check size={9} strokeWidth={3} /> : null}
                  </button>
                  <div className="tray-card-body">
                    {editingId === card.id ? (
                      <textarea
                        className="tray-card-edit"
                        value={editText}
                        autoFocus
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
                          if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                        }}
                        onBlur={() => saveEdit(card)}
                      />
                    ) : plainText(card.text) ? (
                      <span className="tray-card-text" onClick={() => !card.completed && startEdit(card)}>
                        {plainText(card.text)}
                      </span>
                    ) : null}
                    {card.image && uploadsDir && (
                      <img
                        className="tray-card-thumb"
                        src={convertFileSrc(`${uploadsDir}/${card.image}`)}
                        alt=""
                      />
                    )}
                    {!plainText(card.text) && !card.image && editingId !== card.id && (
                      <span className="tray-card-text" onClick={() => !card.completed && startEdit(card)}>
                        <em style={{ opacity: 0.4 }}>untitled</em>
                      </span>
                    )}
                  </div>
                  <button className="tray-card-del" onClick={() => handleDeleteCard(card.id)}>
                    <X size={11} strokeWidth={2} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="tray-footer">
            <button className="tray-open-btn" onClick={handleOpenProject}>
              Open in Surfacer
              <ExternalLink size={11} strokeWidth={2} />
            </button>
            <button className="tray-quit-btn" onClick={() => invoke('quit_app')} title="Quit Surfacer" aria-label="Quit Surfacer">
              <Power size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

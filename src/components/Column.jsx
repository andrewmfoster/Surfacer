import { useState, useRef, useEffect, useCallback } from 'react'
import { api } from '../api'
import { createPortal } from 'react-dom'
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Tag, Trash2 } from 'lucide-react'
import Card from './Card'
import { STATUS_COLORS, STATUS_LABELS } from '../status'
import { plainText } from '../textUtils'

// ── Status chip ───────────────────────────────────────────

const STATUSES = ['active', 'paused', 'shipped', 'idea']

export function StatusChip({ status, onChange }) {
  const cycle = () => {
    const idx = STATUSES.indexOf(status)
    onChange(STATUSES[(idx + 1) % STATUSES.length])
  }
  return (
    <button
      className="status-chip"
      style={{ '--status-color': STATUS_COLORS[status] }}
      onClick={cycle}
      title="Click to change status"
      aria-label={`Status: ${STATUS_LABELS[status]} — click to change`}
    >
      {STATUS_LABELS[status]}
    </button>
  )
}

// ── Tag color ─────────────────────────────────────────────

const TAG_PALETTE = [
  '#c4843c', '#c06080', '#5a9470', '#9060c0',
  '#7fa03c', '#c87858', '#3da090', '#a07040',
]

export function tagColor(id) {
  const hash = id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return TAG_PALETTE[hash % TAG_PALETTE.length]
}

// ── Tag picker ────────────────────────────────────────────

export function TagPicker({ projectTags, allTags, onToggleTag, onCreateTag, onDeleteTag }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef()
  const popoverRef = useRef()

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        btnRef.current && !btnRef.current.contains(e.target)
      ) {
        setOpen(false)
        setInput('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 6, left: rect.left })
    }
    setOpen(o => !o)
  }

  const handleKeyDown = async (e) => {
    if (e.key === 'Enter' && input.trim()) {
      const trimmed = input.trim()
      const exact = allTags.find(t => t.name.toLowerCase() === trimmed.toLowerCase())
      const tag = exact ?? await onCreateTag(trimmed)
      if (!assignedIds.has(tag.id)) onToggleTag(tag)
      setInput('')
    }
    if (e.key === 'Escape') { setOpen(false); setInput('') }
  }

  const assignedIds = new Set(projectTags.map(t => t.id))
  const filtered = input.trim()
    ? allTags.filter(t => t.name.toLowerCase().includes(input.toLowerCase()))
    : allTags

  return (
    <>
      <button ref={btnRef} className="tag-add-btn" onClick={handleOpen} title="Manage tags" aria-label="Manage tags">
        <Tag size={9} strokeWidth={2.5} />
      </button>

      {open && createPortal(
        <div ref={popoverRef} className="tag-popover" style={{ top: pos.top, left: pos.left }}>
          <input
            className="tag-popover-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search or create a tag…"
            autoFocus
          />
          <div className="tag-popover-list">
            {filtered.map(tag => (
              <div key={tag.id} className={`tag-popover-row${assignedIds.has(tag.id) ? ' tag-popover-row--on' : ''}`}>
                <button className="tag-popover-row-main" onClick={() => onToggleTag(tag)}>
                  <span className="tag-pill" style={{ '--tag-bg': tagColor(tag.id) }}>{tag.name}</span>
                  {assignedIds.has(tag.id) && <span className="tag-row-check">✓</span>}
                </button>
                <button
                  className="tag-popover-row-delete"
                  onClick={e => { e.stopPropagation(); onDeleteTag(tag.id) }}
                  title="Delete tag"
                  aria-label={`Delete tag ${tag.name}`}
                >×</button>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="tag-popover-hint">
                {input.trim() ? `Press Enter to create "${input.trim()}"` : 'No tags yet. Type to create one.'}
              </p>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ── Editable title / desc (unchanged) ────────────────────

function EditableTitle({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const titleRef = useRef()

  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.fontSize = '24px'
    while (el.scrollWidth > el.clientWidth && parseFloat(el.style.fontSize) > 9) {
      el.style.fontSize = (parseFloat(el.style.fontSize) - 0.5) + 'px'
    }
  }, [value])

  const commit = () => {
    const val = draft.trim()
    if (val) onChange(val)
    else setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="col-title-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
      />
    )
  }

  return (
    <h2 ref={titleRef} className="col-title" onClick={() => setEditing(true)}>
      {value}
    </h2>
  )
}

export function EditableDesc({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = () => { onChange(draft.trim()); setEditing(false) }

  const autoResize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  if (editing) {
    return (
      <textarea
        ref={el => { if (el) autoResize(el) }}
        autoFocus
        className="col-desc-input"
        value={draft}
        onChange={e => { setDraft(e.target.value); autoResize(e.target) }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        placeholder="Project notes..."
      />
    )
  }

  return (
    <p
      className={`col-desc${!value ? ' col-desc--empty' : ''}`}
      onClick={() => setEditing(true)}
    >
      {value || 'Project notes...'}
    </p>
  )
}

// ── Column ────────────────────────────────────────────────

export default function Column({
  project,
  tags,
  updateProject,
  trashProject,
  addCard,
  addImageCard,
  updateCard,
  deleteCard,
  restoreCard,
  hardDeleteCard,
  reorderCards,
  toggleCardComplete,
  setProjectStatus,
  setProjectTags,
  createTag,
  deleteTag,
}) {
  const [newText, setNewText] = useState('')
  const [adding, setAdding] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } }))

  const activeCards = project.cards.filter(c => !c.completed && !c.deleted)
  const completedCards = project.cards.filter(c => c.completed && !c.deleted)
  const deletedCards = project.cards.filter(c => c.deleted)
  const inputRef = useRef()
  const colRef = useRef(null)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })

  const setRef = useCallback(node => {
    setNodeRef(node)
    colRef.current = node
  }, [setNodeRef])

  const handleMouseMove = useCallback((e) => {
    const el = colRef.current
    if (!el || isDragging) return
    const rect = el.getBoundingClientRect()
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)
    const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2)
    const base = CSS.Transform.toString(transform) || ''
    el.style.transition = 'box-shadow 0.12s'
    el.style.transform = [base, `perspective(1400px) rotateY(${dx * 2.5}deg) rotateX(${-dy * 1.5}deg) translateY(-2px)`].filter(Boolean).join(' ')
    el.style.setProperty('--shine-x', `${((dx + 1) / 2) * 100}%`)
    el.style.setProperty('--shine-y', `${((dy + 1) / 2) * 100}%`)
  }, [isDragging, transform])

  const handleMouseLeave = useCallback(() => {
    const el = colRef.current
    if (!el || isDragging) return
    el.style.transition = 'transform 0.45s cubic-bezier(0.23, 1, 0.32, 1), box-shadow 0.3s'
    el.style.transform = CSS.Transform.toString(transform) || ''
  }, [isDragging, transform])

  const handleFileDragOver = useCallback((e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleFileDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    setIsDragOver(false)
  }, [])

  const handleFileDrop = useCallback(async (e) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file || !file.type.startsWith('image/')) return
    const { filename } = await api.uploadImage(file)
    addImageCard(project.id, filename)
  }, [project.id, addImageCard])

  const submit = () => {
    if (!newText.trim()) { setNewText(''); setAdding(false); return }
    addCard(project.id, newText)
    setNewText('')
    setAdding(false)
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return
    const from = activeCards.findIndex(c => c.id === active.id)
    const to = activeCards.findIndex(c => c.id === over.id)
    reorderCards(project.id, [...arrayMove(activeCards, from, to), ...completedCards])
  }

  const handleDelete = () => {
    trashProject(project.id)
  }

  const handleToggleTag = (tag) => {
    const assigned = project.tags ?? []
    const isOn = assigned.some(t => t.id === tag.id)
    const next = isOn ? assigned.filter(t => t.id !== tag.id) : [...assigned, tag]
    setProjectTags(project.id, next)
  }

  const autoResize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
    '--col-accent': STATUS_COLORS[project.status],
  }

  return (
    <div
      ref={setRef}
      style={style}
      className="column"
      data-project-id={project.id}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      {...attributes}
      {...listeners}
    >
      <div className="col-actions">
        <button
          className="col-delete-pill"
          onClick={handleDelete}
          onPointerDown={e => e.stopPropagation()}
        >
          <Trash2 size={10} strokeWidth={2} />
        </button>
      </div>

      <div className="col-top">
        <div className="col-header">
          <EditableTitle
            value={project.title}
            onChange={val => updateProject(project.id, { title: val })}
          />
        </div>

        <EditableDesc
          value={project.description}
          onChange={val => updateProject(project.id, { description: val })}
        />

        <div className="col-meta">
          <StatusChip
            status={project.status}
            onChange={status => setProjectStatus(project.id, status)}
          />
          <div className="col-tags">
            {(project.tags ?? []).map(t => (
              <span key={t.id} className="tag-pill" style={{ '--tag-bg': tagColor(t.id) }}>
                {t.name}
              </span>
            ))}
            <TagPicker
              projectTags={project.tags ?? []}
              allTags={tags ?? []}
              onToggleTag={handleToggleTag}
              onCreateTag={createTag}
              onDeleteTag={deleteTag}
            />
          </div>
        </div>
      </div>

      <div className="col-divider" />

      <div
        className={`col-cards${isDragOver ? ' col-cards--drag-over' : ''}`}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
        onPointerDown={e => e.stopPropagation()}
      >
        {isDragOver && <div className="col-cards-drop-hint">Drop to add image</div>}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={activeCards.map(c => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {activeCards.map(card => (
              <Card
                key={card.id}
                card={card}
                onUpdate={text => updateCard(project.id, card.id, text)}
                onDelete={() => deleteCard(project.id, card.id)}
                onToggleComplete={() => toggleCardComplete(project.id, card.id)}
              />
            ))}
          </SortableContext>
        </DndContext>

        {completedCards.length > 0 && (
          <>
            <button
              className="col-completed-toggle"
              onClick={() => setShowCompleted(v => !v)}
            >
              <span className="col-completed-arrow">{showCompleted ? '▴' : '▾'}</span>
              {completedCards.length} completed
            </button>
            {showCompleted && (
              <div className="col-completed-cards">
                {completedCards.map(card => (
                  <Card
                    key={card.id}
                    card={card}
                    onUpdate={text => updateCard(project.id, card.id, text)}
                    onDelete={() => deleteCard(project.id, card.id)}
                    onToggleComplete={() => toggleCardComplete(project.id, card.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {deletedCards.length > 0 && (
          <>
            <button
              className="col-completed-toggle col-deleted-toggle"
              onClick={() => setShowDeleted(v => !v)}
            >
              <span className="col-completed-arrow">{showDeleted ? '▴' : '▾'}</span>
              {deletedCards.length} recently deleted
            </button>
            {showDeleted && (
              <div className="col-completed-cards">
                {deletedCards.map(card => (
                  <div key={card.id} className="card-deleted-item">
                    <div className="card-deleted-text">{plainText(card.text)}</div>
                    <div className="card-deleted-actions">
                      <button
                        className="card-deleted-restore"
                        onClick={() => restoreCard(project.id, card.id)}
                        title="Restore"
                        aria-label="Restore card"
                      >↩</button>
                      <button
                        className="card-deleted-remove"
                        onClick={() => hardDeleteCard(project.id, card.id)}
                        title="Delete forever"
                        aria-label="Delete card permanently"
                      >×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {activeCards.length === 0 && completedCards.length === 0 && deletedCards.length === 0 && !adding && <p className="col-empty">No cards yet.</p>}
        {adding ? (
          <textarea
            ref={inputRef}
            autoFocus
            className="col-add-input"
            value={newText}
            placeholder="New card…"
            onChange={e => { setNewText(e.target.value); autoResize(e.target) }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
              if (e.key === 'Escape') { setNewText(''); setAdding(false) }
            }}
            onBlur={submit}
          />
        ) : (
          <button className="col-add-btn" onClick={() => setAdding(true)}>+</button>
        )}
      </div>

    </div>
  )
}

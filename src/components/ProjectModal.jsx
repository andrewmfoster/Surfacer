import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Maximize2, Minimize2 } from 'lucide-react'
import { api } from '../api'
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { StatusChip, TagPicker, EditableDesc, tagColor } from './Column'
import { STATUS_COLORS } from '../status'
import { plainText } from '../textUtils'
import Card from './Card'

function ModalTitle({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => { setDraft(value) }, [value])

  const commit = () => {
    const v = draft.trim()
    onChange(v || value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="modal-title-input"
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
    <h2 className="modal-title" onClick={() => setEditing(true)}>{value}</h2>
  )
}

export default function ProjectModal({
  project, tags, onClose,
  updateProject, addCard, addImageCard, updateCard, deleteCard, restoreCard, hardDeleteCard,
  reorderCards, toggleCardComplete,
  setProjectStatus, setProjectTags, createTag, deleteTag,
}) {
  const [newText, setNewText] = useState('')
  const [adding, setAdding] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef()
  const backdropRef = useRef()
  const modalRef = useRef()
  const closeBtnRef = useRef(null)

  useEffect(() => {
    const el = modalRef.current
    if (!el) return
    if (expanded) {
      el.style.transition = 'transform 0.45s cubic-bezier(0.23, 1, 0.32, 1)'
      el.style.transform = ''
    }
  }, [expanded])

  const handleModalMouseMove = useCallback((e) => {
    if (expanded) return
    const el = modalRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)
    const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2)
    el.style.transition = 'box-shadow 0.12s'
    el.style.transform = `perspective(1400px) rotateY(${dx * 2}deg) rotateX(${-dy * 1.5}deg)`
    el.style.setProperty('--shine-x', `${((dx + 1) / 2) * 100}%`)
    el.style.setProperty('--shine-y', `${((dy + 1) / 2) * 100}%`)
  }, [expanded])

  const handleModalMouseLeave = useCallback(() => {
    const el = modalRef.current
    if (!el) return
    el.style.transition = 'transform 0.45s cubic-bezier(0.23, 1, 0.32, 1)'
    el.style.transform = ''
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } }))

  const activeCards = project.cards.filter(c => !c.completed && !c.deleted)
  const completedCards = project.cards.filter(c => c.completed && !c.deleted)
  const deletedCards = project.cards.filter(c => c.deleted)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // `inert` makes the underlying app non-focusable + non-interactive so Tab stays
  // within the modal. Auto-focusing the close button gives keyboard users a sensible
  // first stop. ProjectModal is portal'd to body, so .app is a sibling — safe to inert.
  useEffect(() => {
    const app = document.querySelector('.app')
    if (app) app.inert = true
    closeBtnRef.current?.focus()
    return () => { if (app) app.inert = false }
  }, [])

  const handleBackdropClick = (e) => {
    if (e.target === backdropRef.current) onClose()
  }

  const submit = () => {
    if (!newText.trim()) { setAdding(false); return }
    addCard(project.id, newText)
    setNewText('')
    setAdding(false)
  }

  const handleToggleTag = (tag) => {
    const assigned = project.tags ?? []
    const isOn = assigned.some(t => t.id === tag.id)
    const next = isOn ? assigned.filter(t => t.id !== tag.id) : [...assigned, tag]
    setProjectTags(project.id, next)
  }

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return
    const from = activeCards.findIndex(c => c.id === active.id)
    const to = activeCards.findIndex(c => c.id === over.id)
    reorderCards(project.id, [...arrayMove(activeCards, from, to), ...completedCards])
  }

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

  const autoResize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return createPortal(
    <div className={`modal-backdrop${expanded ? ' modal-backdrop--expanded' : ''}`} ref={backdropRef} onClick={handleBackdropClick}>
      <div className={`modal${expanded ? ' modal--expanded' : ''}`} ref={modalRef} style={{ '--col-accent': STATUS_COLORS[project.status] }} onMouseMove={handleModalMouseMove} onMouseLeave={handleModalMouseLeave}>
        <div className="modal-corner-btns">
          <button className="modal-expand" onClick={() => setExpanded(e => !e)} title={expanded ? 'Restore' : 'Expand'} aria-label={expanded ? 'Restore modal size' : 'Expand modal'}>
            {expanded ? <Minimize2 size={12} strokeWidth={2} /> : <Maximize2 size={12} strokeWidth={2} />}
          </button>
          <button ref={closeBtnRef} className="modal-close" onClick={onClose} title="Close" aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="modal-top">
          <div className="modal-header">
            <ModalTitle
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
          className={`modal-cards${isDragOver ? ' modal-cards--drag-over' : ''}`}
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
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

          {activeCards.length === 0 && completedCards.length === 0 && deletedCards.length === 0 && !adding && (
            <p className="col-empty">No cards yet.</p>
          )}
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
    </div>,
    document.body
  )
}

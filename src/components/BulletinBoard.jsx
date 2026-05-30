import { useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { tagColor } from './Column'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trash2 } from 'lucide-react'
import { STATUS_COLORS, STATUS_LABELS } from '../status'

function BulletinCard({ project, onOpen, onTrash }) {
  const cardRef = useRef(null)
  const status = project.status ?? 'active'

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  })

  const setRef = useCallback(node => {
    setNodeRef(node)
    cardRef.current = node
  }, [setNodeRef])

  const handleMouseMove = useCallback((e) => {
    const el = cardRef.current
    if (!el || isDragging) return
    const rect = el.getBoundingClientRect()
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)
    const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2)
    const base = CSS.Transform.toString(transform) || ''
    el.style.transition = 'box-shadow 0.12s'
    el.style.transform = [base, `perspective(900px) rotateY(${dx * 3.5}deg) rotateX(${-dy * 2.5}deg) translateY(-2px)`].filter(Boolean).join(' ')
    el.style.setProperty('--shine-x', `${((dx + 1) / 2) * 100}%`)
    el.style.setProperty('--shine-y', `${((dy + 1) / 2) * 100}%`)
  }, [isDragging, transform])

  const handleMouseLeave = useCallback(() => {
    const el = cardRef.current
    if (!el || isDragging) return
    el.style.transition = 'transform 0.45s cubic-bezier(0.23, 1, 0.32, 1), box-shadow 0.3s'
    el.style.transform = CSS.Transform.toString(transform) || ''
  }, [isDragging, transform])

  return (
    <div
      ref={setRef}
      className={`bulletin-card${isDragging ? ' bulletin-card--dragging' : ''}`}
      style={{
        '--col-accent': STATUS_COLORS[status],
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
      }}
      onClick={() => onOpen(project.id)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      {...attributes}
      {...listeners}
    >
      <div className="bulletin-card-actions">
        <button
          className="bulletin-card-delete"
          onClick={e => { e.stopPropagation(); onTrash(project.id) }}
          onPointerDown={e => e.stopPropagation()}
          tabIndex={-1}
        >
          <Trash2 size={10} strokeWidth={2} />
        </button>
      </div>
      <div className="bulletin-card-header">
        <h3 className="bulletin-card-title">{project.title}</h3>
      </div>
      {project.description && (
        <p className="bulletin-card-desc">{project.description}</p>
      )}
      <div className="bulletin-card-meta">
        <span
          className="status-chip"
          style={{ '--status-color': STATUS_COLORS[status] }}
        >
          {STATUS_LABELS[status]}
        </span>
        {(project.tags ?? []).map(t => (
          <span key={t.id} className="tag-pill" style={{ '--tag-bg': tagColor(t.id) }}>
            {t.name}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function BulletinBoard({ projects, onOpen, onTrash, onReorder, reorderDisabled }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleDragEnd = ({ active, over }) => {
    if (reorderDisabled || !over || active.id === over.id) return
    const from = projects.findIndex(p => p.id === active.id)
    const to = projects.findIndex(p => p.id === over.id)
    onReorder(arrayMove(projects, from, to))
  }

  if (projects.length === 0) {
    return (
      <div className="bulletin-board bulletin-board--empty">
        <span>No projects match the current filters.</span>
      </div>
    )
  }
  return (
    <div className="bulletin-board">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={reorderDisabled ? [] : projects.map(p => p.id)} strategy={rectSortingStrategy}>
          <div className="bulletin-grid">
            <AnimatePresence>
              {projects.map((p, i) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 22, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
                  transition={{ type: 'spring', stiffness: 280, damping: 28, delay: i * 0.05 }}
                >
                  <BulletinCard project={p} onOpen={onOpen} onTrash={onTrash} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

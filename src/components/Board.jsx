import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { motion, AnimatePresence } from 'framer-motion'
import Column from './Column'

export default function Board({ projects, reorderProjects, reorderDisabled, ...rest }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 5 } }))

  const handleDragEnd = ({ active, over }) => {
    if (reorderDisabled || !over || active.id === over.id) return
    const from = projects.findIndex(p => p.id === active.id)
    const to = projects.findIndex(p => p.id === over.id)
    reorderProjects(arrayMove(projects, from, to))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={reorderDisabled ? [] : projects.map(p => p.id)} strategy={horizontalListSortingStrategy}>
        <div className="board">
          <AnimatePresence>
            {projects.map((p, i) => (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, y: 18, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
                transition={{ type: 'spring', stiffness: 280, damping: 28, delay: i * 0.05 }}
                style={{ flexShrink: 0 }}
              >
                <Column key={p.id} project={p} {...rest} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </SortableContext>
    </DndContext>
  )
}

import { Trash2, RotateCcw } from 'lucide-react'

export default function TrashView({ trashedProjects, onRestore, onDelete }) {
  return (
    <div className="trash-view">
      <div className="trash-header">
        <span className="trash-title">Recently Deleted</span>
        {trashedProjects.length > 0 && (
          <button
            className="trash-empty-btn"
            onClick={() => trashedProjects.forEach(p => onDelete(p.id))}
          >
            Empty Trash
          </button>
        )}
      </div>

      {trashedProjects.length === 0 ? (
        <div className="trash-empty">
          <Trash2 size={28} strokeWidth={1.2} />
          <span>Trash is empty</span>
        </div>
      ) : (
        <div className="trash-list">
          {trashedProjects.map(p => (
            <div key={p.id} className="trash-item" style={{ '--col-accent': p.color }}>
              <div className="trash-item-swatch" />
              <div className="trash-item-info">
                <span className="trash-item-title">{p.title}</span>
                {p.description && (
                  <span className="trash-item-desc">{p.description}</span>
                )}
                <span className="trash-item-meta">
                  {p.cards.length} {p.cards.length === 1 ? 'card' : 'cards'}
                </span>
              </div>
              <div className="trash-item-actions">
                <button className="trash-restore-btn" onClick={() => onRestore(p.id)}>
                  <RotateCcw size={11} strokeWidth={2} />
                  Restore
                </button>
                <button className="trash-delete-btn" onClick={() => onDelete(p.id)}>
                  Delete Forever
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

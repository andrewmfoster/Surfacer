import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export default function ImageLightbox({ src, onClose }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  return createPortal(
    <div className="lightbox-backdrop" onClick={handleBackdropClick}>
      <button className="modal-close" onClick={onClose} title="Close" aria-label="Close">
        <X size={14} strokeWidth={1.7} />
      </button>
      <img className="lightbox-img" src={src} alt="" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  )
}

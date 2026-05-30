import { useState, useEffect, useRef, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import { useEditor, EditorContent, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useUploadsDir } from '../hooks/useUploadsDir'

export default function Card({ card, onUpdate, onDelete, onToggleComplete }) {
  const uploadsDir = useUploadsDir()
  const [editing, setEditing] = useState(false)
  const [completing, setCompleting] = useState(false)
  const cancelRef = useRef(false)
  const cardRef = useRef(null)
  // dirtyRef: user actually typed during this edit session. Without this, a board-changed
  // refetch landing mid-edit would leave the editor showing stale text, and on blur we'd
  // write that stale HTML back, clobbering newer server data.
  const dirtyRef = useRef(false)
  // cardTextRef tracks the latest server value so Escape restores to current, not the
  // closure value captured when the editor was created.
  const cardTextRef = useRef(card.text)
  cardTextRef.current = card.text

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  })

  const editor = useEditor({
    extensions: [StarterKit, Underline],
    content: card.text,
    editable: false,
    onUpdate: () => { dirtyRef.current = true },
    onBlur: ({ editor }) => {
      if (cancelRef.current) {
        cancelRef.current = false
        editor.commands.setContent(cardTextRef.current, false)
      } else if (dirtyRef.current && !editor.isEmpty) {
        onUpdate(editor.getHTML())
      }
      dirtyRef.current = false
      setEditing(false)
    },
  })

  const fmt = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold') ?? false,
      italic: editor?.isActive('italic') ?? false,
      underline: editor?.isActive('underline') ?? false,
      bullet: editor?.isActive('bulletList') ?? false,
    }),
  }) ?? { bold: false, italic: false, underline: false, bullet: false }

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editing)
    if (editing) requestAnimationFrame(() => editor.commands.focus('end'))
  }, [editing, editor])

  useEffect(() => {
    if (editor && !editing) editor.commands.setContent(card.text, false)
    // Only react to external text changes; editor/editing in deps would cause redundant resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.text])

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
    el.style.setProperty('--shine-x', `${((dx + 1) / 2) * 100}%`)
    el.style.setProperty('--shine-y', `${((dy + 1) / 2) * 100}%`)
  }, [isDragging])

  const handleCheck = (e) => {
    e.stopPropagation()
    if (card.completed) {
      onToggleComplete()
    } else {
      setCompleting(true)
      setTimeout(() => onToggleComplete(), 320)
    }
  }

  const style = completing
    ? {
        opacity: 0,
        transform: 'translateX(-10px) scale(0.97)',
        transition: 'opacity 0.3s ease-out, transform 0.3s ease-out',
        pointerEvents: 'none',
      }
    : {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
      }

  const run = cmd => editor?.chain().focus()[cmd]().run()

  return (
    <div
      ref={setRef}
      style={style}
      className={`card${isDragging ? ' card--dragging' : ''}${card.completed ? ' card--completed' : ''}${card.image ? ' card--has-image' : ''}`}
      onMouseMove={handleMouseMove}
      {...attributes}
      {...listeners}
    >
      <div className="card-actions">
        <button
          className={`card-check${card.completed ? ' card-check--done' : ''}`}
          onClick={handleCheck}
          onPointerDown={e => e.stopPropagation()}
          tabIndex={-1}
          title={card.completed ? 'Mark incomplete' : 'Mark complete'}
          aria-label={card.completed ? 'Mark incomplete' : 'Mark complete'}
        >✓</button>
        <button
          className="card-delete"
          onClick={e => { e.stopPropagation(); onDelete() }}
          onPointerDown={e => e.stopPropagation()}
          tabIndex={-1}
          title="Delete card"
          aria-label="Delete card"
        ><Trash2 size={8} strokeWidth={1.8} /></button>
      </div>

      {card.image && uploadsDir && (
        <img
          className="card-image"
          src={convertFileSrc(`${uploadsDir}/${card.image}`)}
          alt=""
          draggable={false}
          onPointerDown={e => e.stopPropagation()}
        />
      )}

      <div
        className="card-body"
        onClick={() => { if (!editing && !card.completed) setEditing(true) }}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            cancelRef.current = true
            editor?.commands.blur()
          }
        }}
      >
        <EditorContent editor={editor} />

        {editing && editor && (
          <div className="card-toolbar">
            <button
              className={`card-toolbar-btn${fmt.bold ? ' card-toolbar-btn--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); run('toggleBold') }}
            ><strong>B</strong></button>
            <button
              className={`card-toolbar-btn${fmt.italic ? ' card-toolbar-btn--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); run('toggleItalic') }}
            ><em>I</em></button>
            <button
              className={`card-toolbar-btn${fmt.underline ? ' card-toolbar-btn--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); run('toggleUnderline') }}
            ><u>U</u></button>
            <div className="card-toolbar-sep" />
            <button
              className={`card-toolbar-btn${fmt.bullet ? ' card-toolbar-btn--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); run('toggleBulletList') }}
            >≡</button>
          </div>
        )}
      </div>
    </div>
  )
}

import { useState, useEffect, useRef, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { api } from '../api'
import { PROJECT_PALETTE } from '../status'

// Next sort_order for an appended card = one past the highest *visible* card.
// Deriving it from `cards.length` broke once sort_orders went non-contiguous
// (soft-deletes leave gaps; old data even has giant leftover values), letting a
// new card collide with / undershoot an existing one and land mid-list instead
// of last. Ignoring deleted cards also avoids inheriting those stale high values.
const nextCardSortOrder = (cards) =>
  cards.reduce((max, c) => (c.deleted ? max : Math.max(max, c.sort_order ?? -1)), -1) + 1

const ICONS = [
  'Zap', 'Star', 'Flame', 'Music', 'Headphones', 'Code', 'Terminal',
  'Globe', 'Compass', 'Lightbulb', 'BookOpen', 'Pencil', 'Camera',
  'Rocket', 'Target', 'Coffee', 'Wrench', 'Leaf', 'Waves', 'Mountain',
  'Anchor', 'Wind', 'Sun', 'Cpu', 'Radio',
]

const SEED = [
  {
    id: 'seed-loopnest', title: 'LoopNest', description: 'VST plugin. Beat randomizer, drum sample picker.',
    cards: [
      { id: 'seed-ln-1', text: 'BEAT randomizer: randomly picks a drum sample' },
      { id: 'seed-ln-2', text: 'Transient shaping → pitch → 3 attempts → lock (constraint effect?)' },
      { id: 'seed-ln-3', text: 'Can also make a VST plugin directly' },
    ],
  },
  {
    id: 'seed-beatcrate', title: 'BeatCrate', description: 'Get final v1 public on GitHub. Revamp design language.',
    cards: [
      { id: 'seed-bc-1', text: 'Update based on your experience with it' },
      { id: 'seed-bc-2', text: 'Get the final first version public on GitHub' },
      { id: 'seed-bc-3', text: 'Revamp design language — move away from Claude Code style, terracotta direction' },
      { id: 'seed-bc-4', text: 'Single dark mode only — no light mode' },
      { id: 'seed-bc-5', text: 'M4L: explore design possibilities with the notes plugin' },
    ],
  },
  {
    id: 'seed-liros', title: 'LiROS', description: 'Workout app, PR tracker. Write your own programs, graphs of progress.',
    cards: [
      { id: 'seed-lr-1', text: 'Workout app MVP — log sets/reps' },
      { id: 'seed-lr-2', text: 'PR tracker with graph view' },
    ],
  },
  {
    id: 'seed-andrewwander', title: 'AndrewWander.com', description: 'Final code audit. Sensitive data? API keys check.',
    cards: [
      { id: 'seed-aw-1', text: 'ASSEMBLAGES: copy edits' },
      { id: 'seed-aw-2', text: 'ARTIFACTS: copy edits' },
      { id: 'seed-aw-3', text: 'Red Hook — mock of the synth' },
      { id: 'seed-aw-4', text: 'BEATS: volume normalization' },
    ],
  },
  {
    id: 'seed-lifeos', title: 'LifeOS', description: 'Obsidian vault. Continue parsing journal entries.',
    cards: [
      { id: 'seed-lo-1', text: 'Continue parsing journal entries' },
      { id: 'seed-lo-2', text: 'Get the menu chunks closer to what you want' },
    ],
  },
  {
    id: 'seed-researchvault', title: 'ResearchVault', description: 'Obsidian. New use case: scrape articles → download to vault.',
    cards: [
      { id: 'seed-rv-1', text: 'Figure out how to create a skill that scrapes articles and DLs them to Obsidian' },
      { id: 'seed-rv-2', text: 'Use case: research for blog posts and personal learning' },
    ],
  },
  { id: 'seed-glass', title: 'Glass Plugin', description: 'Obsidian plugin.', cards: [] },
  {
    id: 'seed-linkedin', title: 'LinkedIn', description: '',
    cards: [
      { id: 'seed-li-1', text: 'Add site' },
      { id: 'seed-li-2', text: 'Get Aston rec' },
      { id: 'seed-li-3', text: 'Redo description' },
    ],
  },
  {
    id: 'seed-canvas', title: 'Surfacer', description: 'This app. Visual organizer — vertical slices per project.',
    cards: [
      { id: 'seed-cv-1', text: 'v1: add/edit/delete/reorder cards' },
      { id: 'seed-cv-2', text: 'Consider a native wrapper for local app feel' },
    ],
  },
]

function pickIcon(id) {
  const hash = id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return ICONS[hash % ICONS.length]
}

function uid() { return crypto.randomUUID() }

export function useBoard() {
  const [projects, setProjects] = useState([])
  const [trashedProjects, setTrashedProjects] = useState([])
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function init() {
      try {
        const [board, allTags, trash] = await Promise.all([api.getBoard(), api.getTags(), api.getTrash()])

        // Apply tags + trash first so they're committed regardless of what
        // happens with seeding below.
        setTags(allTags)
        setTrashedProjects(trash)

        // Seed/migrate only on a TRULY fresh DB. An empty active board with
        // trashed projects is not fresh — migrate refuses when any project
        // row exists (trashed included), and that throw used to skip the
        // trash assignment, stranding the user on a blank, trash-less board.
        if (board.length === 0 && trash.length === 0) {
          // Migrate from localStorage if data exists, otherwise seed defaults
          const raw = localStorage.getItem('canvas-board-v2')
          const source = raw
            ? JSON.parse(raw)
            : SEED.map((p, i) => ({
                ...p,
                color: PROJECT_PALETTE[i % PROJECT_PALETTE.length],
                cards: p.cards.map(c => ({ ...c, icon: pickIcon(c.id) })),
              }))

          await api.migrate(source)
          if (raw) localStorage.removeItem('canvas-board-v2')

          const migrated = await api.getBoard()
          setProjects(migrated)
        } else {
          setProjects(board)
        }
      } catch (err) {
        console.error('Surfacer API unavailable:', err)
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  // ── Live sync: refetch on any server-side mutation ────────
  const refresh = useCallback(async () => {
    try {
      const [board, allTags, trash] = await Promise.all([api.getBoard(), api.getTags(), api.getTrash()])
      setProjects(board)
      setTags(allTags)
      setTrashedProjects(trash)
    } catch (err) {
      console.error('Refresh failed:', err)
    }
  }, [])

  useEffect(() => {
    // Tauri 2 in-process event bus. No connection / reconnect concerns,
    // so we just subscribe and refresh.
    let unlisten = () => {}
    let cancelled = false
    listen('board-changed', () => refresh()).then((fn) => {
      if (cancelled) { fn(); return }
      unlisten = fn
    })
    return () => { cancelled = true; unlisten() }
  }, [refresh])

  // ── Undo stack ────────────────────────────────────────────
  // Refs always hold the latest state so undo closures don't go stale
  const projectsRef = useRef(projects)
  const trashedProjectsRef = useRef(trashedProjects)
  projectsRef.current = projects
  trashedProjectsRef.current = trashedProjects

  const undoStack = useRef([])

  const pushUndo = (op) => {
    undoStack.current = [...undoStack.current.slice(-19), op]
  }

  const undo = () => {
    const op = undoStack.current[undoStack.current.length - 1]
    if (!op) return
    undoStack.current = undoStack.current.slice(0, -1)
    op()
  }

  // Optimistic mutations are fire-and-forget: they update React state, then
  // persist. If the persist *fails* (e.g. save_card hitting TEXT_MAX, a DB
  // lock, a deserialization mismatch) no `board-changed` event fires, so the
  // optimistic change would otherwise linger in the UI until the next refresh
  // and then silently vanish. Route every mutation through `mutate` so a
  // rejection is logged and the board is re-fetched from the backend (the
  // source of truth), reconciling the stale optimistic state immediately.
  const mutate = (promise, label) => {
    Promise.resolve(promise).catch((err) => {
      console.error(`${label} failed, reconciling from backend:`, err)
      refresh()
    })
  }

  // ── Mutations (optimistic: update state then persist) ──

  const addProject = () => {
    const id = uid()
    const current = projectsRef.current
    const color = PROJECT_PALETTE[current.length % PROJECT_PALETTE.length]
    const project = { id, title: 'New Project', description: '', color, status: 'active', tags: [], cards: [] }
    // Negative timestamp ensures new projects sort before existing ones, with the
    // most recent on top. Normalized back to 0..N by reorderProjects on manual drag.
    const sort_order = current.length === 0 ? 0 : -Date.now()
    setProjects(prev => [project, ...prev])
    mutate(api.saveProject({ id, title: project.title, description: project.description, color, status: 'active', sort_order }), 'saveProject')
    pushUndo(() => {
      setProjects(p => p.filter(q => q.id !== id))
      setTrashedProjects(p => [{ ...project }, ...p])
      mutate(api.trashProject(id), 'trashProject')
    })
  }

  const updateProject = (id, patch) => {
    const current = projectsRef.current
    const old = current.find(p => p.id === id)
    if (!old) return
    const updated = { ...old, ...patch }

    const oldPatch = Object.fromEntries(Object.keys(patch).map(k => [k, old[k]]))
    pushUndo(() => {
      const prev = projectsRef.current
      const reverted = prev.find(p => p.id === id)
      if (!reverted) return
      const r = { ...reverted, ...oldPatch }
      setProjects(p => p.map(q => q.id === id ? { ...q, ...oldPatch } : q))
      mutate(api.saveProject({ id: r.id, title: r.title, description: r.description, color: r.color, status: r.status }), 'saveProject')
    })

    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p))
    mutate(api.saveProject({ id: updated.id, title: updated.title, description: updated.description, color: updated.color, status: updated.status }), 'saveProject')
  }

  const trashProject = (id) => {
    const project = projectsRef.current.find(p => p.id === id)
    if (!project) return
    pushUndo(() => {
      const p = trashedProjectsRef.current.find(q => q.id === id)
      if (!p) return
      setTrashedProjects(prev => prev.filter(q => q.id !== id))
      setProjects(prev => [...prev, { ...p }])
      mutate(api.restoreProject(id), 'restoreProject')
    })
    setProjects(prev => prev.filter(p => p.id !== id))
    setTrashedProjects(prev => [{ ...project }, ...prev])
    mutate(api.trashProject(id), 'trashProject')
  }

  const restoreProject = (id) => {
    const project = trashedProjectsRef.current.find(p => p.id === id)
    if (!project) return
    const sort_order = projectsRef.current.length === 0 ? 0 : -Date.now()
    pushUndo(() => {
      const p = projectsRef.current.find(q => q.id === id)
      if (!p) return
      setProjects(prev => prev.filter(q => q.id !== id))
      setTrashedProjects(prev => [{ ...p }, ...prev])
      mutate(api.trashProject(id), 'trashProject')
    })
    setTrashedProjects(prev => prev.filter(p => p.id !== id))
    setProjects(prev => [{ ...project }, ...prev])
    mutate(api.restoreProject(id), 'restoreProject')
    mutate(api.saveProject({ id: project.id, title: project.title, description: project.description, color: project.color, status: project.status, sort_order }), 'saveProject')
  }

  const deleteProject = (id) => {
    setTrashedProjects(prev => prev.filter(p => p.id !== id))
    mutate(api.deleteProject(id), 'deleteProject')
  }

  const addImageCard = (projectId, filename) => {
    const id = uid()
    const icon = pickIcon(id)
    const project = projectsRef.current.find(p => p.id === projectId)
    if (!project) return
    const sort_order = nextCardSortOrder(project.cards)
    pushUndo(() => {
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, cards: p.cards.filter(c => c.id !== id) } : p
      ))
      mutate(api.deleteCard(id), 'deleteCard')
    })
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, cards: [...p.cards, { id, text: '', icon, image: filename, sort_order }] } : p
    ))
    mutate(api.saveCard({ id, project_id: projectId, text: '', icon, sort_order, image: filename }), 'saveCard')
  }

  const addCard = (projectId, text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const id = uid()
    const icon = pickIcon(id)
    const project = projectsRef.current.find(p => p.id === projectId)
    if (!project) return
    const sort_order = nextCardSortOrder(project.cards)
    pushUndo(() => {
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, cards: p.cards.filter(c => c.id !== id) } : p
      ))
      mutate(api.deleteCard(id), 'deleteCard')
    })
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, cards: [...p.cards, { id, text: trimmed, icon, sort_order }] } : p
    ))
    mutate(api.saveCard({ id, project_id: projectId, text: trimmed, icon, sort_order }), 'saveCard')
  }

  const updateCard = (projectId, cardId, text) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const card = project?.cards.find(c => c.id === cardId)
    if (!project || !card) return
    const sort_order = project.cards.findIndex(c => c.id === cardId)

    if (card.text !== text) {
      const oldText = card.text
      pushUndo(() => {
        setProjects(prev => prev.map(p =>
          p.id !== projectId ? p : { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, text: oldText } : c) }
        ))
        mutate(api.saveCard({ id: cardId, project_id: projectId, text: oldText, icon: card.icon, sort_order }), 'saveCard')
      })
    }

    setProjects(prev => prev.map(p =>
      p.id !== projectId ? p : { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, text } : c) }
    ))
    mutate(api.saveCard({ id: cardId, project_id: projectId, text, icon: card.icon, sort_order }), 'saveCard')
  }

  const deleteCard = (projectId, cardId) => {
    pushUndo(() => {
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, deleted: 0 } : c) } : p
      ))
      mutate(api.restoreCard(cardId), 'restoreCard')
    })
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, deleted: 1 } : c) } : p
    ))
    mutate(api.softDeleteCard(cardId), 'softDeleteCard')
  }

  const restoreCard = (projectId, cardId) => {
    pushUndo(() => {
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, deleted: 1 } : c) } : p
      ))
      mutate(api.softDeleteCard(cardId), 'softDeleteCard')
    })
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, deleted: 0 } : c) } : p
    ))
    mutate(api.restoreCard(cardId), 'restoreCard')
  }

  const hardDeleteCard = (projectId, cardId) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const card = project?.cards.find(c => c.id === cardId)
    if (card) {
      const saved = { ...card }
      pushUndo(() => {
        setProjects(prev => prev.map(p =>
          p.id === projectId ? { ...p, cards: [...p.cards, { ...saved, deleted: 0 }] } : p
        ))
        mutate(api.saveCard({ id: saved.id, project_id: projectId, text: saved.text, icon: saved.icon, sort_order: saved.sort_order ?? 0, image: saved.image }), 'saveCard')
      })
    }
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, cards: p.cards.filter(c => c.id !== cardId) } : p
    ))
    mutate(api.deleteCard(cardId), 'deleteCard')
  }

  const reorderCards = (projectId, newCards) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, cards: newCards } : p))
    mutate(api.reorderCards(newCards.map(c => c.id)), 'reorderCards')
  }

  const toggleCardComplete = (projectId, cardId) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const card = project?.cards.find(c => c.id === cardId)
    if (!card) return
    const oldCompleted = card.completed ? 1 : 0
    const newCompleted = oldCompleted ? 0 : 1

    pushUndo(() => {
      setProjects(prev => prev.map(p =>
        p.id !== projectId ? p : { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, completed: oldCompleted } : c) }
      ))
      mutate(api.completeCard(cardId, oldCompleted), 'completeCard')
    })

    setProjects(prev => prev.map(p =>
      p.id !== projectId ? p : { ...p, cards: p.cards.map(c => c.id === cardId ? { ...c, completed: newCompleted } : c) }
    ))
    mutate(api.completeCard(cardId, newCompleted), 'completeCard')
  }

  const reorderProjects = (newProjects) => {
    setProjects(newProjects)
    mutate(api.reorderProjects(newProjects.map(p => p.id)), 'reorderProjects')
  }

  const setProjectStatus = (projectId, status) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const oldStatus = project?.status
    if (project && oldStatus !== status) {
      pushUndo(() => {
        setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status: oldStatus } : p))
        mutate(api.setProjectStatus(projectId, oldStatus), 'setProjectStatus')
      })
    }
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status } : p))
    mutate(api.setProjectStatus(projectId, status), 'setProjectStatus')
  }

  const setProjectTags = (projectId, newTags) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    const oldTags = project?.tags ?? []
    pushUndo(() => {
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, tags: oldTags } : p))
      mutate(api.setProjectTags(projectId, oldTags.map(t => t.id)), 'setProjectTags')
    })
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, tags: newTags } : p))
    mutate(api.setProjectTags(projectId, newTags.map(t => t.id)), 'setProjectTags')
  }

  const createTag = async (name) => {
    const tag = await api.createTag(name)
    setTags(prev => prev.some(t => t.id === tag.id) ? prev : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)))
    return tag
  }

  const deleteTag = (tagId) => {
    setTags(prev => prev.filter(t => t.id !== tagId))
    setProjects(prev => prev.map(p => ({
      ...p,
      tags: (p.tags ?? []).filter(t => t.id !== tagId),
    })))
    mutate(api.deleteTag(tagId), 'deleteTag')
  }

  return {
    projects, trashedProjects, tags, loading,
    addProject, updateProject, trashProject, restoreProject, deleteProject,
    addCard, addImageCard, updateCard, deleteCard, restoreCard, hardDeleteCard, toggleCardComplete,
    reorderCards, reorderProjects,
    setProjectStatus, setProjectTags, createTag, deleteTag,
    undo,
  }
}

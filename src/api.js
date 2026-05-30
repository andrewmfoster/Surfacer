import { invoke } from '@tauri-apps/api/core'

// Each method maps 1:1 to a #[tauri::command] in src-tauri/src/commands.rs.
// Struct payloads (project, card) keep snake_case field names so they
// match the Rust ProjectInput / CardInput serde defaults; top-level
// command params use camelCase because Tauri auto-converts to snake_case
// on the Rust side (e.g. tagIds → tag_ids).

// ── IPC payload guards ────────────────────────────────────────────────
// saveCard / saveProject construct exactly the shape their Rust input
// struct accepts, so a caller physically cannot spread a serialized DB row
// into a command. The classic trap (CodexReview.md P1 #1): a DB Card
// serializes `completed` as int 0/1, but CardInput types it Option<bool>
// and serde_json refuses int→bool, silently failing the whole call — that's
// how tray edits got lost. This is the chokepoint that makes it impossible.

function toCardInput(c) {
  const out = {
    id: c.id,
    project_id: c.project_id,
    // text/icon are required by save_card's UPDATE (it sets both from the
    // payload on conflict), so forward them as-is.
    text: c.text,
    icon: c.icon,
  }
  // sort_order/image are only honored on INSERT; forward when provided.
  if (typeof c.sort_order === 'number') out.sort_order = c.sort_order
  if (typeof c.image === 'string') out.image = c.image
  // `completed` only as a real bool — never the int 0/1 from a spread row.
  if (typeof c.completed === 'boolean') out.completed = c.completed
  return out
}

function toProjectInput(p) {
  const out = {
    id: p.id,
    title: p.title,
    // save_project's UPDATE sets these from the payload, so forward as-is.
    description: p.description,
    color: p.color,
    status: p.status,
  }
  // Omit sort_order on edits so the UPDATE's COALESCE preserves existing
  // order; include only when the caller explicitly set it (add/restore).
  if (typeof p.sort_order === 'number') out.sort_order = p.sort_order
  return out
}

export const api = {
  getBoard:         ()                    => invoke('get_board'),
  getTrash:         ()                    => invoke('get_trash'),
  saveProject:      (project)             => invoke('save_project', { project: toProjectInput(project) }),
  deleteProject:    (id)                  => invoke('delete_project', { id }),
  trashProject:     (id)                  => invoke('trash_project', { id }),
  restoreProject:   (id)                  => invoke('restore_project', { id }),
  reorderProjects:  (ids)                 => invoke('reorder_projects', { ids }),
  setProjectStatus: (id, status)          => invoke('set_project_status', { id, status }),
  setProjectTags:   (id, tagIds)          => invoke('set_project_tags', { id, tagIds }),
  saveCard:         (card)                => invoke('save_card', { card: toCardInput(card) }),
  deleteCard:       (id)                  => invoke('delete_card', { id }),
  reorderCards:     (ids)                 => invoke('reorder_cards', { ids }),
  completeCard:     (id, completed)       => invoke('complete_card', { id, completed: !!completed }),
  softDeleteCard:   (id)                  => invoke('trash_card', { id }),
  restoreCard:      (id)                  => invoke('restore_card', { id }),
  getTags:          ()                    => invoke('list_tags'),
  createTag:        (name)                => invoke('create_tag', { name }),
  deleteTag:        (id)                  => invoke('delete_tag', { id }),
  migrate:          (projects)            => invoke('migrate', { projects }),
  uploadImage: async (file) => {
    const buf = await file.arrayBuffer()
    // Tauri 2 serializes Vec<u8> as a JSON number array — acceptable for
    // typical screenshot sizes (< 2 MB). See CLAUDE.md for the perf path
    // if this bites later.
    const bytes = Array.from(new Uint8Array(buf))
    const filename = await invoke('upload_image', { bytes, originalFilename: file.name })
    return { filename }
  },
  getUploadsDir:    ()                    => invoke('get_uploads_dir'),
}

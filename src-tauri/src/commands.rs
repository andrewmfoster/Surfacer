use crate::models::{Card, CardInput, MigrateProject, Project, ProjectInput, Tag};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

pub struct DbState(pub Mutex<Connection>);
pub struct UploadsDir(pub PathBuf);

// Single signal that the renderer listens for to refetch board state.
// We deliberately don't emit per-entity events — on in-process IPC the
// refetch cost is nil and "always refetch from the source of truth" is
// simpler to reason about.
// .ok() swallows emit failures: the DB write already happened, and a
// rare emit failure shouldn't make the caller think their mutation failed.
pub(crate) fn notify_board_changed(app: &AppHandle) {
    let _ = app.emit("board-changed", ());
}

// Reject calls from any window other than the main board.
//
// Custom #[tauri::command] functions are NOT gated by the capability system —
// capabilities only cover built-in/plugin commands, so every window can invoke
// every custom command unconditionally (documented in CLAUDE.md). For
// destructive or settings-scoped commands the tray/overlay windows never
// legitimately call, this label check is the only thing standing between a
// compromised tray/overlay renderer and the command. The tray's legitimate
// surface (read board, edit/complete/soft-delete cards, save projects, open in
// main, close/quit) and the overlay's (route/dismiss) deliberately exclude
// everything guarded here.
pub(crate) fn require_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("unauthorized: command restricted to the main window".into());
    }
    Ok(())
}

const ID_MAX: usize = 100;
const TITLE_MAX: usize = 500;
const DESC_MAX: usize = 50_000;
const TEXT_MAX: usize = 200_000;
const ICON_MAX: usize = 40;
const COLOR_MAX: usize = 32;
const TAG_NAME_MAX: usize = 100;
const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const MIGRATE_PROJECTS_MAX: usize = 500;
const MIGRATE_CARDS_PER_PROJECT_MAX: usize = 1000;
const STATUSES: &[&str] = &["active", "paused", "shipped", "idea"];

// Magic-byte sniff. Mirrors server's isAllowedImageMagic: an attacker who
// dropped a .png-named HTML file shouldn't get past this. Sniffs the first
// 12 bytes for PNG / JPEG / GIF / WEBP signatures.
pub(crate) fn is_allowed_image_magic(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return true;
    }
    // JPEG: FF D8 FF
    if bytes[0..3] == [0xFF, 0xD8, 0xFF] {
        return true;
    }
    // GIF: 'GIF8' + ('7'|'9') + 'a'
    if &bytes[0..4] == b"GIF8" && (bytes[4] == b'7' || bytes[4] == b'9') && bytes[5] == b'a' {
        return true;
    }
    // WEBP: 'RIFF' ???? 'WEBP'
    if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true;
    }
    false
}

// Mirrors JS server's IMAGE_FILENAME_RE: /^[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i
// Rejects path traversal, URLs, javascript: schemes — image is rendered with
// convertFileSrc and must be a bare filename in the uploads dir.
fn is_valid_image_filename(s: &str) -> bool {
    let (stem, ext) = match s.rsplit_once('.') {
        Some(p) => p,
        None => return false,
    };
    if stem.is_empty() {
        return false;
    }
    if !stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return false;
    }
    matches!(ext.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp")
}

#[tauri::command]
pub fn get_uploads_dir(uploads: State<'_, UploadsDir>) -> String {
    uploads.0.to_string_lossy().to_string()
}

#[tauri::command]
pub fn get_board(state: State<'_, DbState>) -> Result<Vec<Project>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    load_projects_with_cards_and_tags(&conn, false)
}

#[tauri::command]
pub fn get_trash(state: State<'_, DbState>) -> Result<Vec<Project>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    load_projects_with_cards_and_tags(&conn, true)
}

fn load_projects_with_cards_and_tags(
    conn: &Connection,
    trashed: bool,
) -> Result<Vec<Project>, String> {
    let all_cards = load_all_cards(conn)?;
    let all_tags = load_all_tags(conn)?;
    let all_pt = load_all_project_tags(conn)?;

    let sql = if trashed {
        "SELECT id, title, description, color, status, sort_order, trashed
         FROM projects
         WHERE trashed = 1
         ORDER BY sort_order"
    } else {
        "SELECT id, title, description, color, status, sort_order, trashed
         FROM projects
         WHERE trashed = 0
         ORDER BY sort_order"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let cards: Vec<Card> = all_cards
                .iter()
                .filter(|c| c.project_id == id)
                .cloned()
                .collect();
            let tags: Vec<Tag> = all_pt
                .iter()
                .filter(|(pid, _)| *pid == id)
                .filter_map(|(_, tid)| all_tags.iter().find(|t| &t.id == tid).cloned())
                .collect();
            Ok(Project {
                id,
                title: row.get(1)?,
                description: row.get(2)?,
                color: row.get(3)?,
                status: row.get(4)?,
                sort_order: row.get(5)?,
                trashed: row.get(6)?,
                cards,
                tags,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

#[tauri::command]
pub fn save_project(
    app: AppHandle,
    state: State<'_, DbState>,
    project: ProjectInput,
) -> Result<(), String> {
    if project.id.is_empty() || project.id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    if project.title.is_empty() || project.title.len() > TITLE_MAX {
        return Err("invalid title".into());
    }
    if let Some(ref s) = project.description {
        if s.len() > DESC_MAX {
            return Err("invalid description".into());
        }
    }
    if let Some(ref s) = project.color {
        if s.len() > COLOR_MAX {
            return Err("invalid color".into());
        }
    }
    if let Some(ref s) = project.status {
        if !STATUSES.contains(&s.as_str()) {
            return Err("invalid status".into());
        }
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    // Mirrors the JS server's COALESCE behavior: when sort_order is None,
    // INSERT uses 0 (default for new rows); UPDATE preserves the existing
    // sort_order (so edits to title/desc/status don't shuffle ordering).
    conn.execute(
        "INSERT INTO projects (id, title, description, color, status, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0))
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            color = excluded.color,
            status = excluded.status,
            sort_order = COALESCE(?6, projects.sort_order)",
        params![
            project.id,
            project.title,
            project.description.unwrap_or_default(),
            project.color.unwrap_or_else(|| "#c0392b".into()),
            project.status.unwrap_or_else(|| "active".into()),
            project.sort_order,
        ],
    )
    .map_err(|e| e.to_string())?;

    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn save_card(
    app: AppHandle,
    state: State<'_, DbState>,
    uploads: State<'_, UploadsDir>,
    card: CardInput,
) -> Result<(), String> {
    if card.id.is_empty() || card.id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    if card.project_id.is_empty() || card.project_id.len() > ID_MAX {
        return Err("invalid project_id".into());
    }
    if let Some(ref s) = card.text {
        if s.len() > TEXT_MAX {
            return Err("invalid text".into());
        }
    }
    if let Some(ref s) = card.icon {
        if s.len() > ICON_MAX {
            return Err("invalid icon".into());
        }
    }
    if let Some(ref s) = card.image {
        if !is_valid_image_filename(s) {
            return Err("invalid image".into());
        }
        // Best-effort: don't persist a card pointing at an image that isn't in
        // the uploads dir (typo / desync → broken thumbnail with no error). The
        // file can still be removed afterward, so this only catches the common
        // case, not every race.
        if !uploads.0.join(s).exists() {
            return Err("image file not found".into());
        }
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    // Mirrors the JS server: ON CONFLICT updates only text/icon/sort_order.
    // `completed` and `image` are deliberately untouched on update — completed
    // has its own endpoint, image is set once at creation (screenshot upload).
    conn.execute(
        "INSERT INTO cards (id, project_id, text, icon, sort_order, completed, image)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            text = excluded.text,
            icon = excluded.icon,
            sort_order = excluded.sort_order",
        params![
            card.id,
            card.project_id,
            card.text.unwrap_or_default(),
            card.icon.unwrap_or_else(|| "Zap".into()),
            card.sort_order.unwrap_or(0),
            card.completed.unwrap_or(false) as i64,
            card.image,
        ],
    )
    .map_err(|e| e.to_string())?;

    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn complete_card(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    completed: bool,
) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE cards SET completed = ?1 WHERE id = ?2",
        params![completed as i64, id],
    )
    .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn trash_card(app: AppHandle, state: State<'_, DbState>, id: String) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE cards SET deleted = 1, deleted_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn restore_card(app: AppHandle, state: State<'_, DbState>, id: String) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE cards SET deleted = 0, deleted_at = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_card(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    require_main_window(&window)?;
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cards WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn reorder_cards(
    app: AppHandle,
    state: State<'_, DbState>,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Err("empty reorder list".into());
    }
    for id in &ids {
        if id.is_empty() || id.len() > ID_MAX {
            return Err("invalid id in list".into());
        }
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE cards SET sort_order = ?1 WHERE id = ?2")
            .map_err(|e| e.to_string())?;
        for (idx, id) in ids.iter().enumerate() {
            // 0 rows changed = id doesn't exist; bail so a stale/forged list
            // can't silently no-op. Early return drops the tx → rollback.
            if stmt.execute(params![idx as i64, id]).map_err(|e| e.to_string())? == 0 {
                return Err("unknown card id in reorder list".into());
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn trash_project(app: AppHandle, state: State<'_, DbState>, id: String) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE projects SET trashed = 1 WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn restore_project(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE projects SET trashed = 0 WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    require_main_window(&window)?;
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    // FK cascade handles cards + project_tags.
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn reorder_projects(
    app: AppHandle,
    state: State<'_, DbState>,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Err("empty reorder list".into());
    }
    for id in &ids {
        if id.is_empty() || id.len() > ID_MAX {
            return Err("invalid id in list".into());
        }
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE projects SET sort_order = ?1 WHERE id = ?2")
            .map_err(|e| e.to_string())?;
        for (idx, id) in ids.iter().enumerate() {
            // 0 rows changed = id doesn't exist; bail so a stale/forged list
            // can't silently no-op. Early return drops the tx → rollback.
            if stmt.execute(params![idx as i64, id]).map_err(|e| e.to_string())? == 0 {
                return Err("unknown project id in reorder list".into());
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_project_status(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    status: String,
) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    if !STATUSES.contains(&status.as_str()) {
        return Err("invalid status".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE projects SET status = ?1 WHERE id = ?2",
        params![status, id],
    )
    .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_project_tags(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    // Validate before any DB write — matches JS comment: without this, a bad
    // entry would wipe existing rows via DELETE before the loop threw.
    for t in &tag_ids {
        if t.is_empty() || t.len() > ID_MAX {
            return Err("invalid tagIds".into());
        }
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Reject unknown tag ids up front with a clear message. The FK constraint
    // on project_tags.tag_id would also catch them, but only as a generic DB
    // error mid-transaction. Runs before the DELETE, so an early return leaves
    // existing tags untouched.
    {
        let mut check = tx
            .prepare("SELECT 1 FROM tags WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        for t in &tag_ids {
            if !check.exists(params![t]).map_err(|e| e.to_string())? {
                return Err("unknown tag id".into());
            }
        }
    }
    tx.execute(
        "DELETE FROM project_tags WHERE project_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for t in &tag_ids {
            stmt.execute(params![id, t]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn list_tags(state: State<'_, DbState>) -> Result<Vec<Tag>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    load_all_tags(&conn)
}

#[tauri::command]
pub fn create_tag(app: AppHandle, state: State<'_, DbState>, name: String) -> Result<Tag, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name required".into());
    }
    if trimmed.len() > TAG_NAME_MAX {
        return Err("name too long".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let new_id = Uuid::new_v4().to_string();
    // Idempotent on UNIQUE collision: matches the JS try/catch — if a tag
    // with this name already exists, return the existing row instead of erroring.
    // Only the new-insert branch emits board-changed (no DB change on collision).
    match conn.execute(
        "INSERT INTO tags (id, name) VALUES (?1, ?2)",
        params![new_id, trimmed],
    ) {
        Ok(_) => {
            notify_board_changed(&app);
            Ok(Tag {
                id: new_id,
                name: trimmed.to_string(),
            })
        }
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            conn.query_row(
                "SELECT id, name FROM tags WHERE name = ?1",
                params![trimmed],
                |row| {
                    Ok(Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                },
            )
            .map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_tag(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    require_main_window(&window)?;
    if id.is_empty() || id.len() > ID_MAX {
        return Err("invalid id".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn upload_image(
    uploads: State<'_, UploadsDir>,
    bytes: Vec<u8>,
    original_filename: String,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("no file".into());
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err("file too large".into());
    }
    // Stricter than the JS port: we require a recognized extension up front,
    // rather than saving extensionless and relying on the magic-byte gate as
    // the sole filter. Eliminates the "leaked extensionless file" path.
    let ext = Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "invalid extension".to_string())?;
    if !ALLOWED_UPLOAD_EXTS.contains(&ext.as_str()) {
        return Err("invalid extension".into());
    }
    if !is_allowed_image_magic(&bytes) {
        return Err("invalid image".into());
    }
    // Magic-byte sniff happens before the write, so a rejected upload never
    // touches disk (unlike the JS server, which writes then unlinks on failure).
    let filename = format!("{}.{}", Uuid::new_v4(), ext);
    let path = uploads.0.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(filename)
}

#[tauri::command]
pub fn migrate(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, DbState>,
    projects: Vec<MigrateProject>,
) -> Result<usize, String> {
    require_main_window(&window)?;
    if projects.len() > MIGRATE_PROJECTS_MAX {
        return Err("too many projects".into());
    }
    // Validate everything before opening the transaction — a compromised
    // renderer shouldn't be able to partially mutate the DB before a bad
    // entry trips the loop.
    //
    // Reject duplicate ids in the payload. The inserts below are plain
    // INSERTs (no OR IGNORE), so a duplicate would otherwise abort the
    // transaction mid-way; catching it here surfaces a clear error and
    // keeps the returned count (`projects.len()`) honest — every validated
    // project is guaranteed to insert.
    let mut seen_project_ids: HashSet<&str> = HashSet::new();
    let mut seen_card_ids: HashSet<&str> = HashSet::new();
    for p in &projects {
        if p.id.is_empty() || p.id.len() > ID_MAX {
            return Err("invalid project id".into());
        }
        if !seen_project_ids.insert(p.id.as_str()) {
            return Err("duplicate project id in payload".into());
        }
        if p.title.is_empty() || p.title.len() > TITLE_MAX {
            return Err("invalid project title".into());
        }
        if let Some(ref s) = p.description {
            if s.len() > DESC_MAX {
                return Err("invalid project description".into());
            }
        }
        if let Some(ref s) = p.color {
            if s.len() > COLOR_MAX {
                return Err("invalid project color".into());
            }
        }
        if let Some(ref cards) = p.cards {
            if cards.len() > MIGRATE_CARDS_PER_PROJECT_MAX {
                return Err("too many cards for project".into());
            }
            for c in cards {
                if c.id.is_empty() || c.id.len() > ID_MAX {
                    return Err("invalid card id".into());
                }
                if !seen_card_ids.insert(c.id.as_str()) {
                    return Err("duplicate card id in payload".into());
                }
                if let Some(ref s) = c.text {
                    if s.len() > TEXT_MAX {
                        return Err("invalid card text".into());
                    }
                }
                if let Some(ref s) = c.icon {
                    if s.len() > ICON_MAX {
                        return Err("invalid card icon".into());
                    }
                }
            }
        }
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;

    // Refuse if the board is non-empty. Keeps a compromised renderer from
    // bulk-injecting content into a populated board via this route. Mirrors
    // the JS server's intentional gate.
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if existing > 0 {
        return Err("migrate refused: board not empty".into());
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut insert_project = tx
            .prepare(
                "INSERT INTO projects (id, title, description, color, status, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;
        let mut insert_card = tx
            .prepare(
                "INSERT INTO cards (id, project_id, text, icon, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| e.to_string())?;

        for (i, p) in projects.iter().enumerate() {
            insert_project
                .execute(params![
                    p.id,
                    p.title,
                    p.description.as_deref().unwrap_or(""),
                    p.color.as_deref().unwrap_or("#c0392b"),
                    "active",
                    i as i64,
                ])
                .map_err(|e| e.to_string())?;
            if let Some(ref cards) = p.cards {
                for (j, c) in cards.iter().enumerate() {
                    insert_card
                        .execute(params![
                            c.id,
                            p.id,
                            c.text.as_deref().unwrap_or(""),
                            c.icon.as_deref().unwrap_or("Zap"),
                            j as i64,
                        ])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    notify_board_changed(&app);
    Ok(projects.len())
}

fn load_all_cards(conn: &Connection) -> Result<Vec<Card>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, text, icon, sort_order, completed, deleted, deleted_at, image
             FROM cards
             ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Card {
                id: row.get(0)?,
                project_id: row.get(1)?,
                text: row.get(2)?,
                icon: row.get(3)?,
                sort_order: row.get(4)?,
                completed: row.get(5)?,
                deleted: row.get(6)?,
                deleted_at: row.get(7)?,
                image: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let cards: Result<Vec<Card>, _> = rows.collect();
    cards.map_err(|e| e.to_string())
}

fn load_all_tags(conn: &Connection) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM tags ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let tags: Result<Vec<Tag>, _> = rows.collect();
    tags.map_err(|e| e.to_string())
}

fn load_all_project_tags(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT project_id, tag_id FROM project_tags")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let out: Result<Vec<(String, String)>, _> = rows.collect();
    out.map_err(|e| e.to_string())
}

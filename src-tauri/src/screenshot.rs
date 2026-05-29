// Screenshot-overlay flow: a file watcher on the screenshots dir surfaces a
// routing overlay (show / route / dismiss) via Tauri events + capability-gated
// IPC — no HTTP loopback.
//
// Lifecycle:
//   - settings hook (D/D) calls start_watcher() at boot if screenshotOverlay
//     is true, and on every later toggle.
//   - new PNG in the watched dir → handle_new_screenshot() resizes to a thumb,
//     stashes the original bytes + path in ScreenshotState, emits overlay-data,
//     shows the overlay window.
//   - overlay UI (D/E) calls invoke('overlay_route', {projectId}) or
//     invoke('overlay_dismiss'), defined in D/C.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::ManagerExt as PanelManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::commands::{DbState, UploadsDir};
use crate::settings;

const THUMB_WIDTH: u32 = 296;

// macOS fires FSEvents Create + Modify in close succession when an app
// finishes writing a screenshot. The debouncer coalesces them and also
// gives the file system 300ms to settle before we try to read.
const DEBOUNCE_MS: u64 = 300;

// Shared state. Held as managed state on the AppHandle.
//   watcher        — the active Debouncer; drop = stop watching.
//   pending_bytes  — bytes of the most recent screenshot, uploaded if the
//                    user routes; cleared after route or dismiss.
//   pending_path   — path of that PNG on disk, copied to ~/Desktop on
//                    dismiss if copyToDesktopOnDismiss is on.
pub struct ScreenshotState {
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    pub pending_bytes: Mutex<Option<Vec<u8>>>,
    pub pending_path: Mutex<Option<PathBuf>>,
    // Tracks whether the overlay panel is currently shown. We can't query the
    // NSPanel's isVisible from the watcher's worker thread (nspanel does raw
    // objc msg-send with no internal dispatch → traps off the main thread), so
    // we mirror visibility in this atomic instead. Set true on show, false on
    // hide/route/dismiss; read by the drop-second-screenshot guard.
    pub overlay_visible: AtomicBool,
}

impl Default for ScreenshotState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            pending_bytes: Mutex::new(None),
            pending_path: Mutex::new(None),
            overlay_visible: AtomicBool::new(false),
        }
    }
}

// Resolve the directory to watch.
//   1. screenshot-dir.json (user picked one via Settings → Pick folder)
//   2. macOS's `defaults read com.apple.screencapture location`
//   3. ~/Desktop (macOS default sink)
//
// is_dir() returns true even when we lack read permission — the watcher's
// later `fs::read_dir` check catches EPERM, so we don't double-validate here.
fn resolve_screenshot_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(d) = settings::read_screenshot_dir(app) {
        if let Some(p) = validate_watch_dir(app, &PathBuf::from(d)) {
            return Some(p);
        }
    }
    if let Ok(out) = std::process::Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
    {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !raw.is_empty() {
                let expanded = expand_tilde(app, &raw);
                if let Some(p) = validate_watch_dir(app, &PathBuf::from(expanded)) {
                    return Some(p);
                }
            }
        }
    }
    if let Ok(desktop) = app.path().desktop_dir() {
        if let Some(p) = validate_watch_dir(app, &desktop) {
            return Some(p);
        }
    }
    None
}

// Canonicalize a candidate watch dir and require it to live under the user's
// home directory. Both the settings-file path and the `defaults`-derived path
// are attacker-influenceable (a tampered screenshot-dir.json, a poisoned shell
// profile feeding `defaults read`) and were previously used after only an
// is_dir() check — so a symlink in the chain, or a path pointed straight at
// ~/.ssh or /private/var/log, would redirect the FSEvents watcher there.
// canonicalize() resolves symlinks; the home-prefix check keeps the watcher
// inside the user's own tree. (Cost: a screenshots dir on an external volume
// like /Volumes/... is no longer auto-watched. Relax the prefix if needed.)
fn validate_watch_dir(app: &AppHandle, p: &Path) -> Option<PathBuf> {
    let canonical = p.canonicalize().ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let home = app.path().home_dir().ok()?.canonicalize().ok()?;
    if canonical.starts_with(&home) {
        Some(canonical)
    } else {
        None
    }
}

fn expand_tilde(app: &AppHandle, raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("~") {
        if let Ok(home) = app.path().home_dir() {
            return home
                .join(rest.trim_start_matches('/'))
                .to_string_lossy()
                .to_string();
        }
    }
    raw.to_string()
}

// Seed the known-files set so an already-populated directory doesn't fire
// an overlay for every existing screenshot the moment the watcher starts.
fn seed_known(dir: &Path) -> HashSet<PathBuf> {
    let mut s = HashSet::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("png") {
                s.insert(p);
            }
        }
    }
    s
}

// EPERM on the resolved dir means macOS denied read access (typically
// ~/Desktop without Full Disk Access). Offer to redirect the OS screenshot
// sink to a folder we own and can watch. Non-blocking — `.show()` dispatches and
// returns, so the caller (setup hook on the main thread, or a settings-toggle
// command) never blocks (see the blocking-dialog deadlock gotcha in CLAUDE.md).
// The callback fires on the user's response; "Change Location" runs the
// redirect and starts the watcher on the owned dir, which is readable, so it
// won't re-prompt.
fn prompt_eperm_redirect(app: &AppHandle) {
    let owned_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("Screenshots"),
        Err(e) => {
            eprintln!("[screenshot] no app_data_dir for EPERM redirect: {e}");
            return;
        }
    };
    let detail = format!(
        "Surfacer can't read your Desktop due to macOS permissions, but it can \
         watch a dedicated folder it owns:\n\n{}\n\nYour screenshots will save \
         there. You can change this back anytime in the Screenshot app (Options menu).",
        owned_dir.display()
    );
    let app_cb = app.clone();
    app.dialog()
        .message(detail)
        .title("Change screenshot save location?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Change Location".into(),
            "Skip".into(),
        ))
        .show(move |change| {
            if change {
                redirect_to_owned_dir(&app_cb, &owned_dir);
            } else {
                eprintln!("[screenshot] user skipped EPERM redirect; watcher stays off");
            }
        });
}

// Create a Surfacer-owned screenshots folder, point macOS's screencapture sink
// at it, persist it as the custom dir, and start watching. Same steps as
// settings::pick_screenshots_dir, just sourced from the EPERM prompt instead of
// a folder picker.
fn redirect_to_owned_dir(app: &AppHandle, dir: &Path) {
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[screenshot] failed to create {}: {e}", dir.display());
        return;
    }
    let dir_str = dir.to_string_lossy().to_string();
    let _ = std::process::Command::new("defaults")
        .args(["write", "com.apple.screencapture", "location", &dir_str])
        .status();
    if let Err(e) = settings::write_screenshot_dir(app, &dir_str) {
        eprintln!("[screenshot] failed to persist screenshot dir: {e}");
    }
    eprintln!("[screenshot] screenshot location redirected to {dir_str}");
    let _ = start_watcher(app);
}

pub fn start_watcher(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<ScreenshotState>();
        let guard = state.watcher.lock().unwrap();
        if guard.is_some() {
            // Already running — idempotent. Caller (settings toggle, setup
            // hook) doesn't need to know whether we're a no-op or fresh start.
            return Ok(());
        }
    }

    let dir = match resolve_screenshot_dir(app) {
        Some(d) => d,
        None => {
            eprintln!("[screenshot] no usable screenshots dir; watcher skipped");
            return Ok(());
        }
    };

    // Verify we can actually read it. macOS returns EPERM here when the user
    // hasn't granted Full Disk Access for ~/Desktop. On EPERM, prompt to
    // redirect the screenshot sink to a folder we own. Any other error
    // (missing dir, etc.) just skips — the user can still route around it
    // via Settings → Pick
    // screenshots folder.
    if let Err(e) = fs::read_dir(&dir) {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            eprintln!("[screenshot] EPERM on {} — prompting to redirect", dir.display());
            prompt_eperm_redirect(app);
        } else {
            eprintln!("[screenshot] cannot read {}: {}", dir.display(), e);
        }
        return Ok(());
    }

    let mut known = seed_known(&dir);
    let app_for_handler = app.clone();
    let dir_for_handler = dir.clone();
    let debouncer_result = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        move |res: DebounceEventResult| {
            if let Err(e) = res {
                eprintln!("[screenshot] watch error: {e:?}");
                return;
            }
            // Rescan rather than trust the event's path. macOS's screencapture
            // writes to a dot-prefixed temp file then atomically renames it
            // (`.Screenshot foo.png` → `Screenshot foo.png`); FSEvents +
            // notify-debouncer-mini reliably emit the temp's create event,
            // but the rename-in event on the final filename is missed often
            // enough that the visible behavior is "watcher fires for a path
            // that no longer exists." A directory rescan dodges the bug
            // entirely — a single readdir per debounce window is trivial,
            // and we still skip the dot temps explicitly so the rescan can't
            // try to read one mid-rename.
            let entries = match fs::read_dir(&dir_for_handler) {
                Ok(it) => it,
                Err(e) => {
                    eprintln!(
                        "[screenshot] rescan failed for {}: {e}",
                        dir_for_handler.display()
                    );
                    return;
                }
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.') {
                    continue;
                }
                if path.extension().and_then(|x| x.to_str()) != Some("png") {
                    continue;
                }
                if known.contains(&path) {
                    continue;
                }
                known.insert(path.clone());
                handle_new_screenshot(&app_for_handler, &path);
            }
        },
    );

    let mut debouncer = debouncer_result.map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let state = app.state::<ScreenshotState>();
    *state.watcher.lock().unwrap() = Some(debouncer);
    eprintln!("[screenshot] watching {}", dir.display());
    Ok(())
}

pub fn stop_watcher(app: &AppHandle) {
    let state = app.state::<ScreenshotState>();
    let mut guard = state.watcher.lock().unwrap();
    if guard.take().is_some() {
        eprintln!("[screenshot] watcher stopped");
    }
}

fn handle_new_screenshot(app: &AppHandle, path: &Path) {
    // Drop second concurrent screenshot if the overlay is already showing.
    // The PNG stays on disk in the screenshots folder, just no overlay
    // surfaces until the current one is routed or dismissed.
    if app
        .state::<ScreenshotState>()
        .overlay_visible
        .load(Ordering::SeqCst)
    {
        eprintln!(
            "[screenshot] overlay already open; dropped {}",
            path.display()
        );
        return;
    }

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[screenshot] read failed for {}: {e}", path.display());
            return;
        }
    };

    // resize_png_to_thumbnail decodes the PNG — if the bytes aren't a valid
    // image (an .ico renamed to .png, a half-written file, …) decode fails
    // and we skip. Acts as the magic-byte filter without a separate check.
    let thumb = match resize_png_to_thumbnail(&bytes) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[screenshot] thumbnail failed for {}: {e}", path.display());
            return;
        }
    };
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&thumb)
    );

    let projects = match load_active_projects(app) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[screenshot] project list failed: {e}");
            return;
        }
    };

    // Stash pending state BEFORE showing — route/dismiss commands are gated
    // by these being set.
    {
        let state = app.state::<ScreenshotState>();
        *state.pending_bytes.lock().unwrap() = Some(bytes);
        *state.pending_path.lock().unwrap() = Some(path.to_path_buf());
    }

    show_overlay(app, data_url, projects);
}

fn resize_png_to_thumbnail(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    // thumbnail() does a Lanczos-equivalent fast resize and preserves aspect
    // ratio when one bound is u32::MAX. We only need width to match the
    // overlay's 296px-wide slot.
    let resized = img.thumbnail(THUMB_WIDTH, u32::MAX);
    let mut out = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// Read projects directly from the DB — no point round-tripping through IPC
// just to get our own data back. Matches GET /api/board minus trashed and
// minus card payload (overlay only renders id+title+status).
fn load_active_projects(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, status FROM projects
             WHERE trashed = 0
             ORDER BY sort_order ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(Value::Array(out))
}

fn show_overlay(app: &AppHandle, thumb_data_url: String, projects: Value) {
    let Some(window) = app.get_webview_window("overlay") else {
        eprintln!("[screenshot] overlay window missing");
        return;
    };

    // Bottom-right of the primary monitor with a 20pt margin
    // (workArea.x + workArea.width − winW − 20, …).
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let win_w_phys = (320.0 * scale) as i32;
        let win_h_phys = (420.0 * scale) as i32;
        let margin_phys = (20.0 * scale) as i32;
        let x = pos.x + size.width as i32 - win_w_phys - margin_phys;
        let y = pos.y + size.height as i32 - win_h_phys - margin_phys;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }

    let payload = serde_json::json!({
        "thumbDataUrl": thumb_data_url,
        "projects": projects,
    });

    // Show the overlay panel + make it key so the FIRST click lands on a card or
    // the dismiss button (a non-key panel swallows the first click just to take
    // focus). show_and_make_key does makeFirstResponder + orderFrontRegardless —
    // it does NOT call NSApp.activate, so on this non-activating panel it grabs
    // key focus WITHOUT activating Surfacer or switching you out of a fullscreen
    // Space (that was the old set_focus() bug; this is different). When the
    // overlay hides, key focus returns to the previously-key (fullscreen) window.
    // The panel is non-activating + can_join_all_spaces + full_screen_auxiliary
    // (see init_overlay_panel in lib.rs). nspanel ops do raw objc msg-send with
    // no internal dispatch → MUST run on the main thread; show_overlay runs on
    // the watcher's worker thread, so dispatch.
    let app_show = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = app_show.get_webview_panel("overlay") {
            panel.show_and_make_key();
        }
    });
    app.state::<ScreenshotState>()
        .overlay_visible
        .store(true, Ordering::SeqCst);

    // The overlay window is persistent (mounted once, reused every capture), so
    // its listen('overlay-data') may not be registered yet on the very first
    // show. Tauri's event bus is fire-and-forget with no buffering, so emit
    // after a brief delay to let React attach. 300ms is the same headroom used
    // by open_project_in_main. Cheap to always delay; overlays aren't latency-
    // sensitive (there's an 8s countdown on the card anyway).
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let _ = app2.emit("overlay-data", payload);
    });
}

// Exposed for D/C's commands.
pub fn take_pending(app: &AppHandle) -> (Option<Vec<u8>>, Option<PathBuf>) {
    let state = app.state::<ScreenshotState>();
    let bytes = state.pending_bytes.lock().unwrap().take();
    let path = state.pending_path.lock().unwrap().take();
    (bytes, path)
}

pub fn hide_overlay(app: &AppHandle) {
    app.state::<ScreenshotState>()
        .overlay_visible
        .store(false, Ordering::SeqCst);
    // panel.hide() (orderOut) is a raw objc msg-send → must run on the main
    // thread. Callers (overlay_route / overlay_dismiss) are sync commands that
    // already run on the main thread, but dispatching keeps this safe from any
    // caller and matches show_overlay.
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = app2.get_webview_panel("overlay") {
            panel.hide();
        }
    });
}

// ─── Tauri commands ──────────────────────────────────────────

const PROJECT_ID_MAX: usize = 100;

// Sync — modest DB lock + small file write. Tauri runs sync commands on the
// main thread, and WebviewWindow::hide() internally dispatches via
// send_user_message so the panel-on-worker-thread gotcha from Shell C
// doesn't apply here.
#[tauri::command]
pub fn overlay_route(
    app: AppHandle,
    state: tauri::State<'_, DbState>,
    uploads: tauri::State<'_, UploadsDir>,
    project_id: String,
) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > PROJECT_ID_MAX {
        return Err("invalid project_id".into());
    }

    hide_overlay(&app);

    // Pull pending state out atomically — even if the route fails partway
    // through, the next screenshot starts from a clean slate.
    let (bytes, _path) = take_pending(&app);
    let Some(bytes) = bytes else {
        // Nothing pending — overlay routed twice in quick succession, or the
        // user clicked route after the buffer was already cleared. Quiet success.
        return Ok(());
    };

    // Defense in depth: bytes came from a file we read off disk, but a local
    // attacker who can write to the screenshots dir could land a non-image
    // there between the watcher's read and this call. The magic-byte check is
    // a few µs — cheap insurance.
    if !crate::commands::is_allowed_image_magic(&bytes) {
        return Err("invalid image".into());
    }

    let filename = format!("{}.png", uuid::Uuid::new_v4());
    let dest = uploads.0.join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    let card_id = uuid::Uuid::new_v4().to_string();
    // Append to the bottom of the column. The board sorts by sort_order ASC,
    // and every fresh-card path appends (the main board uses cards.length, the
    // tray uses Date.now()); a large positive ms timestamp keeps screenshot
    // cards consistent with that append-to-bottom convention.
    // as_millis() is u128; `as i64` would truncate silently past i64::MAX.
    // Unreachable for ~292M years, but try_into makes the cast explicit rather
    // than lossy. Falls back to 0 on the (impossible) overflow, same as the
    // pre-epoch error case.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0);

    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        if let Err(e) = conn.execute(
            "INSERT INTO cards (id, project_id, text, icon, sort_order, completed, image)
             VALUES (?1, ?2, '', 'Image', ?3, 0, ?4)",
            rusqlite::params![card_id, project_id, now_ms, filename],
        ) {
            // The PNG was written before the row; if the insert fails (e.g. the
            // project was deleted and the FK rejects it), drop the file so it
            // doesn't linger in uploads/ with nothing referencing it.
            let _ = std::fs::remove_file(&dest);
            return Err(e.to_string());
        }
    }

    crate::commands::notify_board_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn overlay_dismiss(app: AppHandle) -> Result<(), String> {
    hide_overlay(&app);
    let (_bytes, path) = take_pending(&app);

    let settings = settings::read_settings(&app);
    if !settings.copy_to_desktop_on_dismiss {
        return Ok(());
    }
    let Some(src) = path else { return Ok(()) };
    let Ok(desktop) = app.path().desktop_dir() else {
        return Ok(());
    };
    let Some(name) = src.file_name() else {
        return Ok(());
    };
    let dest = desktop.join(name);
    // Guard against copying onto itself — happens when ~/Desktop IS the
    // screenshots dir (the default macOS configuration).
    if dest == src {
        return Ok(());
    }
    // Don't silently clobber an existing Desktop file, and don't follow a
    // symlink an attacker could plant between an exists() check and the write
    // (TOCTOU → arbitrary file write). `create_new(true)` opens atomically and
    // fails with AlreadyExists if the path is occupied — including by a
    // symlink — never writing through it. Walk "<stem> (n).<ext>" candidates
    // until one opens fresh; n == 0 is the bare name. An overwrite here would
    // be unrecoverable data loss, so the numbered variant is belt-and-braces.
    let bytes = match std::fs::read(&src) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[screenshot] dismiss: failed to read {}: {}", src.display(), e);
            return Ok(());
        }
    };
    let p = std::path::Path::new(name);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let ext = p.extension().map(|e| e.to_string_lossy().into_owned());
    let mut n = 0;
    loop {
        let candidate = if n == 0 {
            dest.clone()
        } else {
            match &ext {
                Some(e) => desktop.join(format!("{stem} ({n}).{e}")),
                None => desktop.join(format!("{stem} ({n})")),
            }
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = f.write_all(&bytes) {
                    eprintln!(
                        "[screenshot] dismiss: failed to write {}: {}",
                        candidate.display(),
                        e
                    );
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1;
                if n > 9999 {
                    eprintln!("[screenshot] dismiss: too many name collisions, giving up");
                    break;
                }
            }
            Err(e) => {
                eprintln!(
                    "[screenshot] dismiss: failed to create {}: {}",
                    candidate.display(),
                    e
                );
                break;
            }
        }
    }
    Ok(())
}

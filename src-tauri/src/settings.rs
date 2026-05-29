use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::commands::DbState;

// Settings persistence:
//   - JSON file at <app_data_dir>/settings.json
//   - per-key validators reject malformed mutations from the renderer
//   - 0o600 (rw-------) enforced on every write so future fields can hold
//     sensitive data without a separate migration step
//   - screenshot-dir.json is kept as a *separate* file (predates the
//     settings system; same reasoning as the JS port — see CLAUDE.md)

const SETTINGS_FILE: &str = "settings.json";
const SCREENSHOT_DIR_FILE: &str = "screenshot-dir.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub screenshot_overlay: bool,
    pub tray_icon: bool,
    pub copy_to_desktop_on_dismiss: bool,
    pub start_at_login: bool,
    pub auto_purge_days: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            screenshot_overlay: true,
            tray_icon: true,
            copy_to_desktop_on_dismiss: true,
            start_at_login: false,
            auto_purge_days: 30,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

fn screenshot_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(SCREENSHOT_DIR_FILE))
}

// chmod 0o600 — idempotent. Called after every write so files created before
// the perm enforcement get upgraded on next save. Errors are swallowed because
// some filesystems (FAT, network mounts) don't honor unix perms.
#[cfg(unix)]
fn chmod_user_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn chmod_user_only(_path: &Path) {}

pub fn read_settings(app: &AppHandle) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Settings::default(),
    };
    // Best-effort upgrade for pre-0o600 files.
    chmod_user_only(&path);
    // Merge-on-top-of-defaults so a settings.json missing a field doesn't
    // panic — match the JS port's `{ ...DEFAULTS, ...raw }` behavior. We do
    // this by parsing to Value, then deserializing the merged object.
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Settings::default(),
    };
    let mut defaults = serde_json::to_value(Settings::default()).expect("defaults serialize");
    if let (Some(d), Some(r)) = (defaults.as_object_mut(), parsed.as_object()) {
        // Surface a silent revert: a key the struct expects but the file lacks
        // falls back to its default with no other signal. Logging makes a
        // corrupted/truncated settings.json diagnosable.
        for key in d.keys() {
            if !r.contains_key(key) {
                eprintln!("[settings] '{key}' missing from settings.json; using default");
            }
        }
        for (k, v) in r {
            d.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(defaults).unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &Settings) -> Result<Settings, String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    chmod_user_only(&path);
    Ok(settings.clone())
}

// Per-key untrusted-input validators. Renderer IPC arrives untrusted —
// without these, a compromised renderer could persist e.g. autoPurgeDays
// = "forever" and break the server's purge sweep, or smuggle non-boolean
// truthy values into toggles whose handlers expect booleans.
fn validate(key: &str, value: &serde_json::Value) -> bool {
    match key {
        "screenshotOverlay" | "trayIcon" | "copyToDesktopOnDismiss" | "startAtLogin" => {
            value.is_boolean()
        }
        "autoPurgeDays" => {
            value.as_i64().is_some_and(|n| (1..=3650).contains(&n))
        }
        _ => false,
    }
}

pub fn update_setting(
    app: &AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<Settings, String> {
    if !validate(key, &value) {
        // Reject silently and return current state — matches JS port behavior.
        return Ok(read_settings(app));
    }
    let current = read_settings(app);
    let mut as_json = serde_json::to_value(&current).map_err(|e| e.to_string())?;
    if let Some(obj) = as_json.as_object_mut() {
        obj.insert(key.to_string(), value);
    }
    let next: Settings = serde_json::from_value(as_json).map_err(|e| e.to_string())?;
    write_settings(app, &next)
}

// Custom screenshot dir is stored in its own file (not in settings.json) —
// predates the settings system, kept separate to avoid migration risk.
pub fn read_screenshot_dir(app: &AppHandle) -> Option<String> {
    let path = screenshot_dir_path(app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("dir").and_then(|d| d.as_str()).map(|s| s.to_string())
}

pub fn write_screenshot_dir(app: &AppHandle, dir: &str) -> Result<(), String> {
    let path = screenshot_dir_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::json!({ "dir": dir }).to_string();
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    chmod_user_only(&path);
    Ok(())
}

// Side-effect dispatcher. Mirrors the JS port's applySettingChange. Most
// settings here are read by their consumers (screenshot watcher,
// server-side purge sweep) and need no synchronous side effect.
fn apply_setting_change(app: &AppHandle, key: &str, value: &serde_json::Value) {
    match key {
        "startAtLogin" => {
            if let Some(enabled) = value.as_bool() {
                let autostart = app.autolaunch();
                let _ = if enabled { autostart.enable() } else { autostart.disable() };
            }
        }
        "trayIcon" => {
            if let Some(enabled) = value.as_bool() {
                if enabled {
                    let _ = crate::create_tray_icon(app);
                } else {
                    crate::remove_tray_icon(app);
                }
            }
        }
        "screenshotOverlay" => {
            if let Some(enabled) = value.as_bool() {
                if enabled {
                    let _ = crate::screenshot::start_watcher(app);
                } else {
                    crate::screenshot::stop_watcher(app);
                }
            }
        }
        _ => {}
    }
}

// ─── Tauri commands ──────────────────────────────────────────

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    read_settings(&app)
}

#[tauri::command]
pub fn set_setting(
    app: AppHandle,
    window: tauri::Window,
    key: String,
    value: serde_json::Value,
) -> Result<Settings, String> {
    crate::commands::require_main_window(&window)?;
    let next = update_setting(&app, &key, value.clone())?;
    apply_setting_change(&app, &key, &value);
    Ok(next)
}

// Empty string when no custom screenshots dir is set — renderer uses this
// to decide whether to show the path or a placeholder.
#[tauri::command]
pub fn get_screenshots_dir(app: AppHandle) -> String {
    read_screenshot_dir(&app).unwrap_or_default()
}

#[tauri::command]
pub fn open_screenshots_dir(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::commands::require_main_window(&window)?;
    // Falls back to ~/Desktop when no custom dir — macOS's default screenshot
    // sink. Matches the JS port's behavior.
    let dir = read_screenshot_dir(&app)
        .or_else(|| {
            app.path()
                .desktop_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        })
        .ok_or_else(|| "no screenshots dir".to_string())?;
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| e.to_string())
}

// `async fn` is load-bearing — Tauri dispatches sync commands on the main
// thread, but blocking_pick_folder needs the main thread free to drive the
// NSOpenPanel runloop. Marking the command async moves it onto Tauri's
// worker pool so the main thread can show the dialog. Same applies to
// export_db below.
#[tauri::command]
pub async fn pick_screenshots_dir(
    app: AppHandle,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    crate::commands::require_main_window(&window)?;
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(file_path) = picked else { return Ok(None) };
    let path_str = file_path
        .into_path()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    write_screenshot_dir(&app, &path_str)?;

    // Redirect macOS's screenshot save sink to the chosen folder so new
    // screenshots land where we're watching. Mirrors the JS port's
    // `defaults write com.apple.screencapture location`. We don't restart
    // SystemUIServer — the next screenshot picks up the new value.
    let _ = std::process::Command::new("defaults")
        .args(["write", "com.apple.screencapture", "location", &path_str])
        .status();

    // Restart the watcher so it targets the new dir. If overlay is off,
    // stop is a no-op and start early-returns since no watcher will exist
    // after the stop — so this whole block is cheap on the disabled path.
    if read_settings(&app).screenshot_overlay {
        crate::screenshot::stop_watcher(&app);
        let _ = crate::screenshot::start_watcher(&app);
    }

    Ok(Some(path_str))
}

#[tauri::command]
pub fn reveal_db(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::commands::require_main_window(&window)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("surfacer.db");
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

// User picks a destination via Save dialog; we lock the DB and write a copy
// with `VACUUM INTO`. A plain file copy of `surfacer.db` would miss any
// committed transactions still living in the WAL (`surfacer.db-wal`) — holding
// the connection mutex prevents torn pages but does NOT checkpoint the WAL, so
// the copied file could be silently stale. `VACUUM INTO` runs on the live
// connection and emits a fresh, fully-consistent database that folds in all
// committed WAL data. It refuses to overwrite, so clear an existing target.
#[tauri::command]
pub async fn export_db(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, DbState>,
) -> Result<Option<String>, String> {
    crate::commands::require_main_window(&window)?;
    let dest = app
        .dialog()
        .file()
        .add_filter("SQLite database", &["db"])
        .set_file_name("surfacer.db")
        .blocking_save_file();
    let Some(file_path) = dest else { return Ok(None) };
    let dest_path = file_path.into_path().map_err(|e| e.to_string())?;
    let dest_str = dest_path.to_string_lossy().to_string();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // Refuse to write through a symlink. `symlink_metadata` does NOT follow
    // links, so this catches a symlink planted at the chosen path (TOCTOU →
    // writing the DB through it to an arbitrary target). Lower risk than the
    // overlay copy since the user just picked this path in a save dialog, but
    // the check-then-write shape is identical, so guard it the same way.
    if std::fs::symlink_metadata(&dest_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("refusing to export through a symlink".into());
    }
    if dest_path.exists() {
        std::fs::remove_file(&dest_path).map_err(|e| e.to_string())?;
    }
    conn.execute("VACUUM INTO ?1", [dest_str.as_str()])
        .map_err(|e| e.to_string())?;
    Ok(Some(dest_str))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    // Verifies the export_db fix at the SQLite level: a plain file copy of the
    // main .db misses committed data still in the WAL, but `VACUUM INTO` (what
    // export_db now runs on the live connection) captures it. Mirrors db::open's
    // WAL mode; autocheckpoint is disabled so committed rows stay in the WAL
    // exactly like the real-world stale-export scenario.
    #[test]
    fn vacuum_into_captures_wal_only_data() {
        let dir = std::env::temp_dir().join(format!("surfacer_export_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("surfacer.db");
        for f in ["surfacer.db", "surfacer.db-wal", "surfacer.db-shm"] {
            let _ = std::fs::remove_file(dir.join(f));
        }

        let conn = Connection::open(&src).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", [])
            .unwrap();
        conn.execute("INSERT INTO t (v) VALUES ('hello')", []).unwrap();

        // OLD behavior: copy only surfacer.db -> the committed row lives in the
        // WAL, so the standalone copy can't see it (table isn't even there yet).
        let plain = dir.join("plain_copy.db");
        let _ = std::fs::remove_file(&plain);
        std::fs::copy(&src, &plain).unwrap();
        let plain_conn = Connection::open(&plain).unwrap();
        let plain_count: i64 = plain_conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap_or(-1);
        assert_ne!(plain_count, 1, "plain copy unexpectedly saw the WAL-only row");

        // FIX: VACUUM INTO emits a complete, standalone snapshot.
        let dest = dir.join("export.db");
        let _ = std::fs::remove_file(&dest);
        let dest_str = dest.to_string_lossy().to_string();
        conn.execute("VACUUM INTO ?1", [dest_str.as_str()]).unwrap();

        let exported = Connection::open(&dest).unwrap();
        let exported_count: i64 = exported
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        let v: String = exported
            .query_row("SELECT v FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(exported_count, 1, "export missed the WAL-only row");
        assert_eq!(v, "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

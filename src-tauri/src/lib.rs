// `tauri_panel!`'s `panel_event!` grammar mandates a `-> <type>` return, so the
// generated hide-on-blur handler is `-> ()`, which trips clippy::unused_unit.
// The lint is checked in the macro-expansion context, so an item-level allow on
// the invocation doesn't reach it; suppress crate-wide (the only `-> ()` in this
// crate is the macro-imposed one).
#![allow(clippy::unused_unit)]

mod commands;
mod db;
mod models;
mod screenshot;
mod settings;

use commands::{DbState, UploadsDir};
use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    ActivationPolicy, AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt as PanelManagerExt, PanelLevel, StyleMask,
    WebviewWindowExt,
};
use tauri_plugin_autostart::{ManagerExt as AutostartManagerExt, MacosLauncher};

// Tray window is converted to an NSPanel so it can be non-activating (keeps the
// foreground app's menu bar intact when shown) and reachable across all Spaces
// and full-screen apps. show_and_make_key() is required — plain show() skips
// key-focus, so window_did_resign_key (hide-on-blur) never fires.
// Both the tray and overlay windows are converted to NSPanels. A non-activating
// NSPanel is the ONLY reliable way to float a window over another app's
// full-screen Space on macOS — a plain WebviewWindow won't appear on a
// full-screen Space no matter what collection behavior you set (it reports
// isOnActiveSpace=false there). Non-activating so surfacing them never steals
// focus from the foreground/full-screen app. Both panel types must live in ONE
// tauri_panel! block — the macro defines shared symbols (NSEvent, …) at module
// scope, so a second invocation collides (E0252). Only the tray needs an event
// handler (hide-on-blur); the overlay self-dismisses via its 8s countdown or an
// explicit route/dismiss click, so it has no panel_event!.
tauri_panel! {
    panel!(TrayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel!(OverlayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel_event!(TrayPanelEvents {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

// Logical (point) width of the tray panel — must match tauri.conf.json
// `windows[label="tray"].width`. Used only as a fallback if the window's
// actual outer_size lookup fails; toggle_tray_panel reads outer_size at
// runtime so retina/scale-factor math stays correct regardless of this const.
const TRAY_PANEL_WIDTH_LOGICAL: f64 = 360.0;

// Restrict a directory to its owner (0o700). `create_dir_all` honors the
// process umask, so a loose umask would leave the app data dir — which holds
// the SQLite DB and uploaded images — group/other-readable. macOS home dirs
// are single-user by convention, but this makes the guarantee explicit and
// mirrors settings.rs's 0o600 treatment of the log file. (Dirs need the
// execute bit to be traversable, hence 0o700 not 0o600.)
#[cfg(unix)]
fn chmod_dir_owner_only(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn chmod_dir_owner_only(_path: &std::path::Path) {}

// Holds the live TrayIcon so settings.rs can drop it when the user toggles
// trayIcon off. Mutex<Option<…>> not OnceLock<…>, because we need to swap
// the icon in and out at runtime, not just lazy-initialize once.
pub struct TrayIconHandle(pub Mutex<Option<TrayIcon>>);

pub fn create_tray_icon(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<TrayIconHandle>();
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let tray = TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/Su.png"))
        .icon_as_template(true)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let (x, y) = match rect.position {
                    tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
                    tauri::Position::Logical(p) => (p.x, p.y),
                };
                let w = match rect.size {
                    tauri::Size::Physical(s) => s.width as f64,
                    tauri::Size::Logical(s) => s.width,
                };
                toggle_tray_panel(tray.app_handle(), x, y, w);
            }
        })
        .build(app)?;
    *guard = Some(tray);
    Ok(())
}

pub fn remove_tray_icon(app: &AppHandle) {
    let state = app.state::<TrayIconHandle>();
    let mut guard = state.0.lock().unwrap();
    if let Some(tray) = guard.take() {
        // Dropping the local TrayIcon alone wouldn't free the menu-bar slot —
        // the manager keeps a clone in its resources_table. remove_tray_by_id
        // pulls it out of the manager so the last reference goes away when
        // both this taken Option and the returned value go out of scope.
        let _ = app.remove_tray_by_id(tray.id());
    }
}

fn init_tray_panel(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("tray")
        .ok_or("tray window not found")?;
    let panel = window
        .to_panel::<TrayPanel>()
        .map_err(|_| "failed to wrap tray window as NSPanel")?;

    panel.set_level(PanelLevel::Floating.value());
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );
    // tauri.conf.json's `shadow: false` on the window doesn't survive the
    // NSPanel conversion — wrapping the window as an NSPanel re-enables the
    // OS-drawn shadow. Disable it explicitly here so the rounded .tray-panel
    // doesn't get a faint rectangular halo around it from AppKit.
    panel.set_has_shadow(false);

    let handler = TrayPanelEvents::new();
    let app_clone = app.clone();
    handler.window_did_resign_key(move |_| {
        if let Ok(p) = app_clone.get_webview_panel("tray") {
            p.hide();
        }
    });
    panel.set_event_handler(Some(handler.as_ref()));

    Ok(())
}

// Convert the overlay window to a non-activating NSPanel so it floats over
// full-screen apps and across all Spaces (see the OverlayPanel doc comment).
// Same recipe as the tray panel, minus the resign-key handler. Floating level
// (3) is enough — the panel-ness, not the level, is what wins over full screen.
fn init_overlay_panel(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("overlay")
        .ok_or("overlay window not found")?;
    let panel = window
        .to_panel::<OverlayPanel>()
        .map_err(|_| "failed to wrap overlay window as NSPanel")?;

    panel.set_level(PanelLevel::Floating.value());
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );
    // Same shadow gotcha as the tray: NSPanel conversion re-enables the OS shadow
    // that tauri.conf.json's `shadow: false` had turned off. The overlay's
    // #overlay-card is a flat rounded card (the "Shell C halo" lesson) — kill the
    // window shadow so it doesn't get a rectangular halo around the rounded corners.
    panel.set_has_shadow(false);

    Ok(())
}

fn toggle_tray_panel(app: &AppHandle, tray_x: f64, tray_y: f64, tray_width: f64) {
    let panel = match app.get_webview_panel("tray") {
        Ok(p) => p,
        Err(_) => return,
    };

    if panel.is_visible() {
        panel.hide();
        return;
    }

    if let Some(window) = app.get_webview_window("tray") {
        // tray-icon's macOS impl returns the rect in *physical* pixels
        // (`LogicalPosition::to_physical(scale)`), so the panel width must
        // also be physical to keep the centering math in one coordinate
        // system. Query outer_size live — it tracks the actual rendered
        // physical width regardless of scale factor or future resize.
        let panel_w_phys = window
            .outer_size()
            .map(|s| s.width as f64)
            .unwrap_or_else(|_| {
                TRAY_PANEL_WIDTH_LOGICAL * window.scale_factor().unwrap_or(1.0)
            });
        let new_x = tray_x + (tray_width / 2.0) - (panel_w_phys / 2.0);
        let new_y = tray_y + 4.0;
        let _ = window.set_position(PhysicalPosition::new(new_x, new_y));
    }
    panel.show_and_make_key();
}

// Surface the "main" window: show + focus it if it still exists (e.g.
// minimized), otherwise recreate it from the same config used at startup.
// Shared by open_project_in_main (tray → Open) and the RunEvent::Reopen
// handler (dock-icon click). When focus_id is Some, it's emitted as
// "focus-project" — immediately for an existing window, or AFTER the renderer's
// page-load for a freshly built one (Tauri events are fire-and-forget, so we
// wait for React's listen() to register — see CLAUDE.md).
//
// MUST be called off the main thread: WebviewWindowBuilder::build internally
// posts work to the main runtime via run_on_main_thread and would deadlock if
// the caller is occupying the main thread (same gotcha as blocking dialog APIs,
// see CLAUDE.md). Both callers dispatch it onto a worker accordingly.
// Flip to Accessory (background) mode when the main window is destroyed, so the
// Dock running-dot disappears while the pinned icon tile stays. MUST be
// re-attached to every main window instance: a window recreated by
// build_main_window is a fresh object that does NOT inherit the previous
// window's handler — without re-attaching, the dot stopped clearing on the
// second and later closes.
fn attach_main_close_handler(window: &WebviewWindow, app: &AppHandle) {
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
        }
    });
}

fn build_main_window(app: &AppHandle, focus_id: Option<String>) -> Result<(), String> {
    // Back to a foreground app: restores the dock running-indicator dot that
    // the Accessory flip on window-close removed (see the close handler in
    // setup). set_activation_policy dispatches to the event loop internally, so
    // it's safe to call from the worker thread both callers run us on.
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(id) = focus_id {
            let _ = app.emit("focus-project", id);
        }
        return Ok(());
    }

    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| "main window config not found".to_string())?;

    let app_emit = app.clone();
    let window = WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|e| e.to_string())?
        .on_page_load(move |_w, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                if let Some(id) = focus_id.clone() {
                    let app2 = app_emit.clone();
                    // Brief delay lets React mount + register listen('focus-project').
                    // 300ms is empirical headroom — listener registration on a cold
                    // Vite/React start is ~tens of ms; the buffer covers slow machines.
                    tauri::async_runtime::spawn_blocking(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        let _ = app2.emit("focus-project", id);
                    });
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    // Brand-new window object → re-attach the close handler it doesn't inherit.
    attach_main_close_handler(&window, app);

    Ok(())
}

// Async so Tauri dispatches it off the main thread (see build_main_window's
// deadlock note).
#[tauri::command]
async fn open_project_in_main(id: String, app: AppHandle) -> Result<(), String> {
    // Direct NSPanel.hide() from a worker thread traps in AppKit (NSWindow
    // ops require the main thread). Dispatch through the main runtime.
    let app_for_hide = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = app_for_hide.get_webview_panel("tray") {
            panel.hide();
        }
    });

    build_main_window(&app, Some(id))
}

// Sync — Tauri runs sync commands on the main thread, which is required for
// the NSPanel.hide() call (AppKit traps NSWindow ops from worker threads).
// An earlier async version of this command crashed with EXC_BREAKPOINT the
// first time the user clicked the tray's X button.
#[tauri::command]
fn close_tray(app: AppHandle) {
    if let Ok(panel) = app.get_webview_panel("tray") {
        panel.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// Hard-delete cards soft-deleted longer than the user's autoPurgeDays window.
// Runs once at startup then every 24h. Reads the setting fresh each sweep, so a
// changed window takes effect on the next daily pass without a restart. No
// board-changed event is emitted — purged cards were already soft-deleted and
// hidden, so nothing visible changes.
fn run_purge_sweep(app: &AppHandle) {
    let days = settings::read_settings(app).auto_purge_days;
    let days = if days > 0 { days } else { 30 }; // fallback window
    let now_secs = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return,
    };
    let cutoff = now_secs - days * 24 * 60 * 60;
    let state = app.state::<DbState>();
    let conn = match state.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    match db::purge_expired_cards(&conn, cutoff) {
        Ok(n) if n > 0 => eprintln!("[purge] removed {n} card(s) deleted >{days} days ago"),
        Ok(_) => {}
        Err(e) => eprintln!("[purge] WARN: {e}"),
    }
}

pub fn run() {
    tauri::Builder::default()
        // Single-instance lock must register before any window-creating plugin.
        // On a second launch, focus the existing main window instead of
        // spawning a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("startup: could not resolve the app data dir (~/Library/Application Support/com.surfacer.app)");
            std::fs::create_dir_all(&app_dir)
                .unwrap_or_else(|e| panic!("startup: failed to create app data dir {}: {e}", app_dir.display()));
            chmod_dir_owner_only(&app_dir);

            let db_path = app_dir.join("surfacer.db");

            let uploads_dir = app_dir.join("uploads");
            std::fs::create_dir_all(&uploads_dir)
                .unwrap_or_else(|e| panic!("startup: failed to create uploads dir {}: {e}", uploads_dir.display()));
            chmod_dir_owner_only(&uploads_dir);

            let conn = db::open(&db_path)
                .unwrap_or_else(|e| panic!("startup: failed to open database {} (corrupt DB or failed integrity check?): {e}", db_path.display()));
            app.manage(DbState(Mutex::new(conn)));
            app.manage(UploadsDir(uploads_dir));
            app.manage(TrayIconHandle(Mutex::new(None)));
            app.manage(screenshot::ScreenshotState::default());

            // Reconcile the OS login-item DB with the persisted setting on
            // every launch — the user may have toggled the login item via
            // System Settings, or settings.json may have changed while the
            // app wasn't running. The setting is the source of truth.
            let settings = settings::read_settings(app.handle());
            let autostart = app.autolaunch();
            let enabled = autostart.is_enabled().unwrap_or(false);
            if settings.start_at_login && !enabled {
                let _ = autostart.enable();
            } else if !settings.start_at_login && enabled {
                let _ = autostart.disable();
            }

            init_tray_panel(app.handle())?;

            // When the main window closes, drop to Accessory (background) mode.
            // For a Dock-PINNED app this keeps the icon tile in the Dock but
            // removes the running-indicator dot. The tray icon keeps the app
            // alive; clicking the pinned Dock icon (or the tray's Open)
            // recreates the window via build_main_window, which flips back to
            // Regular so the dot returns. (See the RunEvent::Reopen handler in
            // run() below.)
            //
            // NB: if the app is NOT pinned to the Dock, Accessory removes the
            // icon tile entirely — there's no way to show a pinned-style icon
            // without a running dot for an unpinned app; the two are coupled.
            if let Some(main_window) = app.get_webview_window("main") {
                attach_main_close_handler(&main_window, app.handle());
            }

            if settings.tray_icon {
                create_tray_icon(app.handle())?;
            }

            // Convert the overlay to a non-activating NSPanel so it can float
            // over full-screen apps + all Spaces. Done once at setup regardless
            // of the overlay setting; the conversion persists for the app's life.
            init_overlay_panel(app.handle())?;

            if settings.screenshot_overlay {
                // Errors are non-fatal — a missing/unreadable screenshots dir
                // shouldn't block startup. screenshot::start_watcher already
                // logs to stderr on each failure path.
                let _ = screenshot::start_watcher(app.handle());
            }

            // 24h purge sweep for expired soft-deleted cards. First pass runs
            // ~now, then every 24h. Runs on its own thread so the sweep's DB
            // lock never blocks the setup hook or command handling.
            {
                let purge_app = app.handle().clone();
                std::thread::spawn(move || loop {
                    run_purge_sweep(&purge_app);
                    std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_project_in_main,
            close_tray,
            quit_app,
            commands::get_uploads_dir,
            commands::get_board,
            commands::get_trash,
            commands::save_project,
            commands::trash_project,
            commands::restore_project,
            commands::delete_project,
            commands::reorder_projects,
            commands::set_project_status,
            commands::set_project_tags,
            commands::save_card,
            commands::complete_card,
            commands::trash_card,
            commands::restore_card,
            commands::delete_card,
            commands::reorder_cards,
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::upload_image,
            commands::migrate,
            settings::get_settings,
            settings::set_setting,
            settings::get_screenshots_dir,
            settings::open_screenshots_dir,
            settings::pick_screenshots_dir,
            settings::reveal_db,
            settings::export_db,
            screenshot::overlay_route,
            screenshot::overlay_dismiss,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS dock-icon click with no open window → recreate the main
            // window. has_visible_windows is false after the user has X'd the window
            // out. build_main_window's build() is dispatched onto a worker so
            // the main thread stays free to service it (see its deadlock note).
            if let RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = build_main_window(&app, None) {
                        eprintln!("[reopen] {e}");
                    }
                });
            }
        });
}

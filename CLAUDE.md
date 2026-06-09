# Surfacer

A macOS desktop app for visually organizing projects: a board of vertical project columns with cards, status filters, tags, a menu-bar tray popover, and a screenshot-routing overlay. Rust + Tauri 2 backend, React renderer, local SQLite. Small bundle, no Chromium attack surface, capability-gated IPC with no network listener.

Design language — status colors, drag behaviors, the screenshot overlay, and tray popover requirements — lives in the code: status mapping in `src/status.js`, layout/visuals in `src/App.css` (and the per-window CSS files).

## Architectural decisions (locked in)

- **No Node sidecar.** Backend is pure Rust via `#[tauri::command]`. The renderer calls `invoke('cmd_name', args)`; there is no separate server process.
- **No HTTP loopback.** Communication is Tauri IPC only — no network listener bound anywhere.
- **Coarse events, not per-entity.** A mutation calls `app.emit("board-changed", ())`; the renderer uses `listen('board-changed', ...)` from `@tauri-apps/api/event` and refetches the whole board. Simpler than per-entity events, and on in-process IPC the refetch cost is nil.
- **DB path.** `~/Library/Application Support/com.surfacer.app/surfacer.db` (Tauri derives the dir from the bundle identifier). WAL mode; schema init + integrity check happen on open — see `db.rs`.

## Running

```
npm run tauri dev
```

First Rust build is slow (~3-5 min, compiles bundled SQLite from source). Incremental rebuilds on lib.rs changes are ~2-3s.

Window close ≠ app quit. The tray icon keeps the app alive when the main window is closed; clicking the (pinned) Dock icon reopens it.

## Stack

- **Frontend:** Vite + React + TypeScript (`src/`)
- **Backend:** Rust + Tauri 2 (`src-tauri/`)
- **DB:** rusqlite 0.40 with `bundled` feature (own libsqlite3, no system dep)
- **Panel/tray:** `tauri-nspanel` v2.1 branch — tray popover + non-activating overlay panel, both live.

## Module layout (`src-tauri/src/`)

- `lib.rs` — Tauri::Builder, setup hook (opens DB, manages State), command registration
- `db.rs` — `open()` (WAL, foreign keys, integrity check, user_version stamp), schema init
- `models.rs` — `Project` / `Card` / `Tag` / `ProjectInput` (Serialize/Deserialize)
- `commands.rs` — all `#[tauri::command]` functions + `DbState(Mutex<Connection>)`
- `settings.rs` — settings get/set, screenshot-dir picker, DB export
- `screenshot.rs` — FSEvents watcher → overlay panel

Keep this flat until commands.rs exceeds ~500 LOC, then split into `commands/{board,projects,cards,tags,upload}.rs`.

## Build from source

```
npm install
npm run tauri build   # → src-tauri/target/release/bundle/macos/Surfacer.app (+ a .dmg)
```

## Progress

See the git log — commit messages spell out what each session landed.

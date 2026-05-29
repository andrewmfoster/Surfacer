use rusqlite::{Connection, Result as SqliteResult};
use std::path::Path;

pub const SCHEMA_VERSION: u32 = 1;

pub fn open(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;

    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err(format!("SQLite integrity_check failed: {integrity}"));
    }

    check_version(&conn)?;
    init_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn check_version(conn: &Connection) -> Result<(), String> {
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "DB schema version {version} is newer than this build (expects {SCHEMA_VERSION}). Update Surfacer or restore a backup."
        ));
    }
    if version < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Project',
            description TEXT DEFAULT '',
            color TEXT DEFAULT '#c0392b',
            status TEXT DEFAULT 'active',
            sort_order INTEGER DEFAULT 0,
            trashed INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            text TEXT NOT NULL,
            icon TEXT DEFAULT 'Zap',
            sort_order INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            deleted INTEGER DEFAULT 0,
            deleted_at INTEGER DEFAULT NULL,
            image TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_tags (
            project_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (project_id, tag_id),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        -- Backfill NULL columns to schema defaults. SQLite's column DEFAULTs only
        -- apply on INSERT when the column is omitted; explicit NULLs persist.
        -- A real DB was observed with cards having NULL icon (2 rows). Rust's
        -- struct types are non-nullable, so query deserialization fails the
        -- whole get_board on such a row. This UPDATE is idempotent
        -- — no-op after first boot since these columns will all be non-NULL.
        UPDATE projects SET description = '' WHERE description IS NULL;
        UPDATE projects SET color = '#c0392b' WHERE color IS NULL;
        UPDATE projects SET status = 'active' WHERE status IS NULL;
        UPDATE projects SET sort_order = 0 WHERE sort_order IS NULL;
        UPDATE projects SET trashed = 0 WHERE trashed IS NULL;
        UPDATE cards SET icon = 'Zap' WHERE icon IS NULL;
        UPDATE cards SET sort_order = 0 WHERE sort_order IS NULL;
        UPDATE cards SET completed = 0 WHERE completed IS NULL;
        UPDATE cards SET deleted = 0 WHERE deleted IS NULL;
        "#,
    )
}

// Hard-delete cards soft-deleted before `cutoff_secs` (Unix seconds).
// deleted_at is stored as `.as_secs()`, so the cutoff is in the same unit.
// Returns the number of rows removed.
pub fn purge_expired_cards(conn: &Connection, cutoff_secs: i64) -> SqliteResult<usize> {
    conn.execute(
        "DELETE FROM cards WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff_secs],
    )
}

#[cfg(test)]
mod tests {
    // The P1 "blank board + unreachable trash" bug: a board whose only projects
    // are trashed. This pins the three Rust facts the renderer fix relies on,
    // against the real schema: get_board (WHERE trashed=0) is empty, get_trash
    // (WHERE trashed=1) is non-empty, and migrate's COUNT(*) guard sees a row
    // (so it refuses) — which is why the renderer must NOT treat an empty active
    // board as a fresh DB to seed.
    #[test]
    fn all_trashed_board_query_facts() {
        let dir = std::env::temp_dir().join(format!("surfacer_trash_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dbp = dir.join("surfacer.db");
        let _ = std::fs::remove_file(&dbp);

        let conn = super::open(&dbp).unwrap();
        conn.execute(
            "INSERT INTO projects (id, title, trashed) VALUES ('p1', 'Trashed', 1)",
            [],
        )
        .unwrap();

        let active: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE trashed = 0", [], |r| r.get(0))
            .unwrap();
        let trashed: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE trashed = 1", [], |r| r.get(0))
            .unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();

        assert_eq!(active, 0, "get_board would return [] (no active projects)");
        assert_eq!(trashed, 1, "get_trash would return the trashed project");
        assert!(total > 0, "migrate's COUNT(*) guard sees a row and refuses");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

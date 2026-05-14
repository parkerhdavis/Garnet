// SPDX-License-Identifier: AGPL-3.0-or-later
//! Sidebar pinned sources. A pin targets either a whole library root or a
//! sub-folder under one, and surfaces as a NavLink in the sidebar's Sources
//! section. The on-disk pin stores `(root_id, relative_path_to_root)` so it
//! follows the root if the root is later renamed (the root row keeps the same
//! id and the relative path is preserved), and so removing a root cascades to
//! its pins.

use crate::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PinnedSource {
	pub id: i64,
	pub root_id: i64,
	pub root_path: String,
	pub relative_path: String,
	pub abs_path: String,
	pub name: String,
	pub added_at: i64,
}

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

fn join_abs(root_path: &str, relative: &str) -> String {
	if relative.is_empty() {
		root_path.to_string()
	} else {
		format!("{root_path}/{relative}")
	}
}

#[tauri::command]
pub fn list_pinned_sources(state: State<AppState>) -> Result<Vec<PinnedSource>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare(
			"SELECT ps.id, ps.root_id, r.path, ps.relative_path_to_root, ps.name, ps.added_at
			 FROM pinned_sources ps
			 JOIN library_roots r ON r.id = ps.root_id
			 ORDER BY ps.added_at ASC",
		)
		.map_err(stringify)?;
	let rows = stmt
		.query_map([], |r| {
			let id: i64 = r.get(0)?;
			let root_id: i64 = r.get(1)?;
			let root_path: String = r.get(2)?;
			let relative_path: String = r.get(3)?;
			let name: String = r.get(4)?;
			let added_at: i64 = r.get(5)?;
			let abs_path = join_abs(&root_path, &relative_path);
			Ok(PinnedSource {
				id,
				root_id,
				root_path,
				relative_path,
				abs_path,
				name,
				added_at,
			})
		})
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}

/// Find the library root that contains `abs_path` and return its id plus the
/// path of `abs_path` relative to the root (empty string for the root itself).
/// Errors if no registered root contains the path.
fn resolve_under_root(
	conn: &rusqlite::Connection,
	abs_path: &Path,
) -> Result<(i64, String), String> {
	let canonical = abs_path
		.canonicalize()
		.map_err(|e| format!("could not resolve {abs_path:?}: {e}"))?;
	if !canonical.is_dir() {
		return Err(format!("{canonical:?} is not a directory"));
	}

	let mut stmt = conn
		.prepare("SELECT id, path FROM library_roots")
		.map_err(stringify)?;
	let rows = stmt
		.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
		.map_err(stringify)?;

	for row in rows {
		let (id, path) = row.map_err(stringify)?;
		let root = PathBuf::from(&path);
		if canonical == root {
			return Ok((id, String::new()));
		}
		if let Ok(rel) = canonical.strip_prefix(&root) {
			return Ok((id, rel.to_string_lossy().to_string()));
		}
	}

	Err(format!(
		"{} is not inside any registered library root — add the parent folder under \
		 Settings → Library Roots first",
		canonical.to_string_lossy()
	))
}

fn default_name(abs_path: &Path) -> String {
	abs_path
		.file_name()
		.and_then(|s| s.to_str())
		.map(|s| s.to_string())
		.unwrap_or_else(|| abs_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pin_source(
	state: State<AppState>,
	abs_path: String,
	name: Option<String>,
) -> Result<PinnedSource, String> {
	let path = PathBuf::from(&abs_path);
	let conn = state.db.lock().map_err(stringify)?;
	let (root_id, relative) = resolve_under_root(&conn, &path)?;

	let display_name = name
		.as_ref()
		.map(|s| s.trim().to_string())
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| default_name(&path));

	conn.execute(
		"INSERT INTO pinned_sources (root_id, relative_path_to_root, name, added_at)
		 VALUES (?1, ?2, ?3, strftime('%s','now'))
		 ON CONFLICT(root_id, relative_path_to_root) DO NOTHING",
		params![root_id, relative, display_name],
	)
	.map_err(stringify)?;

	let row = conn
		.query_row(
			"SELECT ps.id, ps.root_id, r.path, ps.relative_path_to_root, ps.name, ps.added_at
			 FROM pinned_sources ps
			 JOIN library_roots r ON r.id = ps.root_id
			 WHERE ps.root_id = ?1 AND ps.relative_path_to_root = ?2",
			params![root_id, relative],
			|r| {
				let root_path: String = r.get(2)?;
				let relative_path: String = r.get(3)?;
				let abs_path = join_abs(&root_path, &relative_path);
				Ok(PinnedSource {
					id: r.get(0)?,
					root_id: r.get(1)?,
					root_path,
					relative_path,
					abs_path,
					name: r.get(4)?,
					added_at: r.get(5)?,
				})
			},
		)
		.map_err(stringify)?;

	tracing::info!("pinned source id={} path={}", row.id, row.abs_path);
	Ok(row)
}

#[tauri::command]
pub fn unpin_source(state: State<AppState>, id: i64) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("DELETE FROM pinned_sources WHERE id = ?1", [id])
		.map_err(stringify)?;
	tracing::info!("unpinned source id={id}");
	Ok(())
}

/// Internal helper used by `list_assets` when filtering by a pinned source —
/// looks up the pin and returns (root_id, relative_path_to_root). Public to
/// the crate so `assets.rs` can call it without re-implementing the join.
pub fn resolve_pinned_source(
	conn: &rusqlite::Connection,
	id: i64,
) -> rusqlite::Result<(i64, String)> {
	conn.query_row(
		"SELECT root_id, relative_path_to_root FROM pinned_sources WHERE id = ?1",
		[id],
		|r| Ok((r.get(0)?, r.get(1)?)),
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::db::MIGRATIONS;
	use rusqlite::Connection;

	fn fresh_db() -> Connection {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
		)
		.unwrap();
		for (v, sql) in MIGRATIONS {
			conn.execute_batch(sql).unwrap();
			conn.execute(
				"INSERT INTO migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
				[v],
			)
			.unwrap();
		}
		conn
	}

	fn register_root(conn: &Connection, path: &Path) -> i64 {
		conn.execute(
			"INSERT INTO library_roots (path, added_at) VALUES (?1, strftime('%s','now'))",
			[path.to_string_lossy()],
		)
		.unwrap();
		conn.last_insert_rowid()
	}

	#[test]
	fn pin_root_itself() {
		let tmp = tempfile::tempdir().unwrap();
		let conn = fresh_db();
		register_root(&conn, tmp.path());

		let (root_id, rel) = resolve_under_root(&conn, tmp.path()).unwrap();
		assert!(root_id > 0);
		assert_eq!(rel, "");
	}

	#[test]
	fn pin_subfolder_of_root() {
		let tmp = tempfile::tempdir().unwrap();
		let sub = tmp.path().join("Classical").join("Bach");
		std::fs::create_dir_all(&sub).unwrap();
		let conn = fresh_db();
		register_root(&conn, tmp.path());

		let (_, rel) = resolve_under_root(&conn, &sub).unwrap();
		assert_eq!(rel, "Classical/Bach");
	}

	#[test]
	fn rejects_path_outside_any_root() {
		let tmp_root = tempfile::tempdir().unwrap();
		let other = tempfile::tempdir().unwrap();
		let conn = fresh_db();
		register_root(&conn, tmp_root.path());

		let err = resolve_under_root(&conn, other.path()).err().unwrap();
		assert!(err.contains("not inside any registered library root"));
	}

	#[test]
	fn cascades_on_root_deletion() {
		let tmp = tempfile::tempdir().unwrap();
		let conn = fresh_db();
		// foreign_keys must be ON in tests for CASCADE to fire.
		conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
		let root_id = register_root(&conn, tmp.path());
		conn.execute(
			"INSERT INTO pinned_sources (root_id, relative_path_to_root, name, added_at)
			 VALUES (?1, '', 'TheRoot', strftime('%s','now'))",
			[root_id],
		)
		.unwrap();
		let count: i64 = conn
			.query_row("SELECT COUNT(*) FROM pinned_sources", [], |r| r.get(0))
			.unwrap();
		assert_eq!(count, 1);

		conn.execute("DELETE FROM library_roots WHERE id = ?1", [root_id])
			.unwrap();
		let count: i64 = conn
			.query_row("SELECT COUNT(*) FROM pinned_sources", [], |r| r.get(0))
			.unwrap();
		assert_eq!(count, 0);
	}
}

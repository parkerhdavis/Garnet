// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library roots and the scan command. The actual scanning logic lives in
//! `crate::indexer` — this module just wraps it as a Tauri command and owns
//! the register/list/remove commands that round out the root lifecycle.

use crate::indexer;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LibraryRoot {
	pub id: i64,
	pub path: String,
	pub added_at: i64,
}

pub use indexer::ScanReport;

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

#[tauri::command]
pub fn register_library_root(state: State<AppState>, path: String) -> Result<LibraryRoot, String> {
	let canonical = Path::new(&path)
		.canonicalize()
		.map_err(|e| format!("could not resolve {path:?}: {e}"))?;
	if !canonical.is_dir() {
		return Err(format!("{canonical:?} is not a directory"));
	}
	let path_str = canonical.to_string_lossy().to_string();

	let conn = state.db.lock().map_err(stringify)?;
	conn.execute(
		"INSERT INTO library_roots (path, added_at) VALUES (?1, strftime('%s','now'))
		 ON CONFLICT(path) DO NOTHING",
		[&path_str],
	)
	.map_err(stringify)?;

	let row = conn
		.query_row(
			"SELECT id, path, added_at FROM library_roots WHERE path = ?1",
			[&path_str],
			|r| {
				Ok(LibraryRoot {
					id: r.get(0)?,
					path: r.get(1)?,
					added_at: r.get(2)?,
				})
			},
		)
		.map_err(stringify)?;

	tracing::info!("registered library root id={} path={}", row.id, row.path);
	Ok(row)
}

#[tauri::command]
pub fn list_library_roots(state: State<AppState>) -> Result<Vec<LibraryRoot>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare("SELECT id, path, added_at FROM library_roots ORDER BY added_at ASC")
		.map_err(stringify)?;
	let rows = stmt
		.query_map([], |r| {
			Ok(LibraryRoot {
				id: r.get(0)?,
				path: r.get(1)?,
				added_at: r.get(2)?,
			})
		})
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}

#[tauri::command]
pub fn remove_library_root(state: State<AppState>, id: i64) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("DELETE FROM library_roots WHERE id = ?1", [id])
		.map_err(stringify)?;
	tracing::info!("removed library root id={id}");
	Ok(())
}

#[tauri::command]
pub fn scan_library_root(state: State<AppState>, id: i64) -> Result<ScanReport, String> {
	let root_path: String = {
		let conn = state.db.lock().map_err(stringify)?;
		conn.query_row(
			"SELECT path FROM library_roots WHERE id = ?1",
			[id],
			|r| r.get::<_, String>(0),
		)
		.map_err(|e| format!("unknown library root id={id}: {e}"))?
	};

	let conn = state.db.lock().map_err(stringify)?;
	indexer::scan_root(&conn, id, &PathBuf::from(&root_path)).map_err(stringify)
}

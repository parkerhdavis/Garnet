// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library roots and the stub indexer. The indexer is intentionally minimal
//! for Phase 1: it walks the directory tree under a root and inserts one row
//! per file with `relative_path`, `size`, `mtime`, and a guessed-by-extension
//! `format` tag. Real metadata extraction (EXIF, ID3, stream info, etc.) lives
//! in modules and lands in later phases.

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LibraryRoot {
	pub id: i64,
	pub path: String,
	pub added_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScanReport {
	pub root_id: i64,
	pub files_seen: u64,
	pub files_inserted: u64,
	pub files_skipped: u64,
}

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

	let root = PathBuf::from(&root_path);
	let mut report = ScanReport {
		root_id: id,
		files_seen: 0,
		files_inserted: 0,
		files_skipped: 0,
	};

	let conn = state.db.lock().map_err(stringify)?;
	let tx = conn.unchecked_transaction().map_err(stringify)?;
	{
		let mut insert = tx
			.prepare(
				"INSERT INTO assets (root_id, relative_path, size, mtime, format)
				 VALUES (?1, ?2, ?3, ?4, ?5)
				 ON CONFLICT(root_id, relative_path) DO UPDATE SET
					size = excluded.size,
					mtime = excluded.mtime,
					format = excluded.format",
			)
			.map_err(stringify)?;

		for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
			if !entry.file_type().is_file() {
				continue;
			}
			report.files_seen += 1;

			let abs = entry.path();
			let relative = match abs.strip_prefix(&root) {
				Ok(p) => p.to_string_lossy().to_string(),
				Err(_) => {
					report.files_skipped += 1;
					continue;
				}
			};

			let meta = match entry.metadata() {
				Ok(m) => m,
				Err(_) => {
					report.files_skipped += 1;
					continue;
				}
			};
			let size = meta.len() as i64;
			let mtime = meta
				.modified()
				.ok()
				.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
				.map(|d| d.as_secs() as i64);
			let format = abs
				.extension()
				.and_then(|s| s.to_str())
				.map(|s| s.to_ascii_lowercase());

			insert
				.execute(rusqlite::params![id, relative, size, mtime, format])
				.map_err(stringify)?;
			report.files_inserted += 1;
		}
	}
	tx.commit().map_err(stringify)?;

	tracing::info!(
		"scan complete: root_id={} seen={} inserted={} skipped={}",
		id, report.files_seen, report.files_inserted, report.files_skipped
	);
	Ok(report)
}

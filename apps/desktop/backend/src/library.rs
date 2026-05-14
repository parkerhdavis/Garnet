// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library roots and the scan command. The actual scanning logic lives in
//! `crate::indexer` — this module wraps it as Tauri commands and owns the
//! register/list/remove commands that round out the root lifecycle.
//!
//! Scans run on tokio's blocking pool with their own SQLite connection, so
//! they don't compete for the `AppState.db` mutex and don't block the IPC
//! command thread. Lifecycle events are emitted as Tauri events:
//!
//!   - `scan:started`   payload: `{ root_id }`
//!   - `scan:completed` payload: `ScanReport`
//!   - `scan:failed`    payload: `{ root_id, error }`
//!
//! The frontend listens for these to refresh its views when new content lands.

use crate::indexer;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LibraryRoot {
	pub id: i64,
	pub path: String,
	pub added_at: i64,
}

pub use indexer::ScanReport;

#[derive(Serialize, Clone, Debug)]
struct ScanFailedPayload {
	root_id: i64,
	error: String,
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

/// Kicks off a scan in the background and returns immediately. The actual
/// scan runs on tokio's blocking pool with its own SQLite connection. Progress
/// is reported via Tauri events; the frontend listens and refreshes its views
/// when `scan:completed` fires.
#[tauri::command]
pub fn scan_library_root(
	state: State<AppState>,
	app: AppHandle,
	id: i64,
) -> Result<(), String> {
	// Look up the root path on the IPC thread before spawning — fast SQL
	// query, and lets us return a clear error to the caller if the root
	// doesn't exist.
	let root_path: PathBuf = {
		let conn = state.db.lock().map_err(stringify)?;
		let path: String = conn
			.query_row(
				"SELECT path FROM library_roots WHERE id = ?1",
				[id],
				|r| r.get(0),
			)
			.map_err(|e| format!("unknown library root id={id}: {e}"))?;
		PathBuf::from(path)
	};
	spawn_scan(app, id, root_path);
	Ok(())
}

/// Spawn a background scan task. Opens its own SQLite connection so it
/// doesn't compete with the shared `AppState.db` mutex for read-side
/// commands (list_assets, list_library_roots, …) while writing.
pub fn spawn_scan(app: AppHandle, id: i64, root_path: PathBuf) {
	tauri::async_runtime::spawn_blocking(move || {
		let _ = app.emit("scan:started", id);
		match run_scan(id, &root_path) {
			Ok(report) => {
				tracing::info!(
					"scan completed: root_id={} seen={} inserted={} updated={} renamed={} deleted={}",
					id,
					report.files_seen,
					report.files_inserted,
					report.files_updated,
					report.files_renamed,
					report.files_deleted,
				);
				let _ = app.emit("scan:completed", &report);
			}
			Err(e) => {
				let msg = format!("{e:#}");
				tracing::error!("scan failed: root_id={} err={}", id, msg);
				let _ = app.emit(
					"scan:failed",
					ScanFailedPayload { root_id: id, error: msg },
				);
			}
		}
	});
}

fn run_scan(id: i64, root_path: &Path) -> anyhow::Result<ScanReport> {
	let path = crate::db::db_path()?;
	let conn = rusqlite::Connection::open(&path)?;
	conn.execute_batch(
		"PRAGMA foreign_keys = ON;
		 PRAGMA journal_mode = WAL;
		 PRAGMA busy_timeout = 5000;",
	)?;
	Ok(indexer::scan_root(&conn, id, root_path)?)
}

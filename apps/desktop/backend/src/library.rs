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
use crate::watcher::WatcherState;
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
pub fn register_library_root(
	state: State<AppState>,
	watcher: State<WatcherState>,
	path: String,
) -> Result<LibraryRoot, String> {
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

	// Hook the new root into the live-watcher so changes under it produce
	// debounced rescans without requiring an app restart.
	if let Ok(mut w) = watcher.0.lock() {
		if let Err(e) = w.watch(row.id, &canonical) {
			tracing::warn!("watcher: failed to watch new root_id={}: {}", row.id, e);
		}
	}

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
pub fn remove_library_root(
	state: State<AppState>,
	watcher: State<WatcherState>,
	id: i64,
) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("DELETE FROM library_roots WHERE id = ?1", [id])
		.map_err(stringify)?;
	if let Ok(mut w) = watcher.0.lock() {
		let _ = w.unwatch_root(id);
	}
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

/// Per-root scan slot. We must not let two scans run for the same root
/// concurrently: each one snapshots `assets WHERE root_id=?` before its
/// transaction begins (see `indexer::scan_root`), so if two start in parallel
/// they both see the same pre-state, both INSERT the same rows, and the
/// second hits `UNIQUE(root_id, relative_path)` when it commits. The three
/// spawn sites (startup auto-scan, manual Scan button, watcher debounce)
/// don't coordinate otherwise; this is where we coordinate them.
///
/// Coalescing semantics: if a scan is requested while one is already
/// running for that root, the request is recorded as `pending` (overwriting
/// any earlier pending). When the running scan finishes, the pending request
/// is dispatched as a fresh scan. That way no event batch is silently lost —
/// activity that arrived during a long scan still gets indexed — without
/// ever letting two scans run in parallel for the same root.
struct ScanSlot {
	running: bool,
	pending: Option<(AppHandle, PathBuf)>,
}

fn slots() -> &'static std::sync::Mutex<std::collections::HashMap<i64, ScanSlot>> {
	use std::sync::OnceLock;
	static MAP: OnceLock<std::sync::Mutex<std::collections::HashMap<i64, ScanSlot>>> =
		OnceLock::new();
	MAP.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Try to claim the scan slot for `id`. Returns true if we acquired it
/// (caller should start running); false if a scan was already in flight (in
/// which case we recorded the request as pending for after).
fn claim_or_pending(id: i64, app: AppHandle, root_path: PathBuf) -> bool {
	let mut map = match slots().lock() {
		Ok(g) => g,
		Err(e) => {
			tracing::error!("scan: slots lock poisoned: {e}");
			return false;
		}
	};
	let slot = map.entry(id).or_insert(ScanSlot { running: false, pending: None });
	if slot.running {
		slot.pending = Some((app, root_path));
		tracing::debug!("scan: root_id={} already in flight; coalesced as pending follow-up", id);
		false
	} else {
		slot.running = true;
		true
	}
}

/// Mark the running scan for `id` as done and return any pending follow-up
/// the caller should now dispatch.
fn finish(id: i64) -> Option<(AppHandle, PathBuf)> {
	let mut map = match slots().lock() {
		Ok(g) => g,
		Err(e) => {
			tracing::error!("scan: slots lock poisoned on finish: {e}");
			return None;
		}
	};
	let slot = map.get_mut(&id)?;
	slot.running = false;
	let follow_up = slot.pending.take();
	if follow_up.is_none() {
		// Slot is fully idle — drop it so the map doesn't accumulate entries
		// for roots we've stopped watching.
		map.remove(&id);
	}
	follow_up
}

/// Spawn a background scan task. Opens its own SQLite connection so it
/// doesn't compete with the shared `AppState.db` mutex for read-side
/// commands (list_assets, list_library_roots, …) while writing.
///
/// At most one scan runs per root at a time; concurrent requests are
/// coalesced into a single follow-up scan that fires once the current one
/// finishes.
pub fn spawn_scan(app: AppHandle, id: i64, root_path: PathBuf) {
	if !claim_or_pending(id, app.clone(), root_path.clone()) {
		return;
	}

	tauri::async_runtime::spawn_blocking(move || {
		let _ = app.emit("scan:started", id);
		let result = run_scan(id, &root_path);

		// Release the slot before emitting completion so a listener that
		// immediately requests another scan finds it free. Capture any
		// pending follow-up that arrived while we were running.
		let follow_up = finish(id);

		match result {
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

		if let Some((next_app, next_path)) = follow_up {
			tracing::debug!("scan: dispatching coalesced follow-up for root_id={}", id);
			spawn_scan(next_app, id, next_path);
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

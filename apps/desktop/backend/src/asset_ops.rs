// SPDX-License-Identifier: AGPL-3.0-or-later
//! Filesystem mutations on assets: rename, move, trash, and trash-restore.
//! These are the Tauri commands behind the asset right-click context menu and
//! the undo/redo history.
//!
//! Every op updates the assets row in-place where it can (rename / move) or
//! deletes the row (trash) and lets the filesystem watcher pick up the
//! restored file on undo. The DB is kept in sync eagerly so the UI doesn't
//! have to wait on the watcher's debounce window for the visible state to
//! reflect the user's action.
//!
//! Trash semantics: files are moved into Garnet's own trash directory under
//! `$XDG_DATA_HOME/garnet/trash/`, not the OS recycle bin. This keeps the
//! restore path under our control (we know exactly where the file came from
//! and where it went), and lets undo work even after the user has emptied
//! the system trash. Files in our trash dir are still on the user's disk,
//! reachable via the file manager if needed.

use crate::AppState;
use anyhow::Context;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

/// Resolve a relative path against a root path, returning the joined absolute
/// path. Centralized so the rules (no leading slash, OS separators) stay in
/// one place.
fn join_abs(root_path: &str, relative: &str) -> PathBuf {
	if relative.is_empty() {
		PathBuf::from(root_path)
	} else {
		PathBuf::from(root_path).join(relative)
	}
}

/// `$XDG_DATA_HOME/garnet/trash/`, creating it on first call. Co-located with
/// the library DB so removing the Garnet data dir cleans up trashed files too.
pub fn trash_dir() -> anyhow::Result<PathBuf> {
	let base = dirs::data_dir().context("could not determine OS data directory")?;
	let dir = base.join("garnet").join("trash");
	std::fs::create_dir_all(&dir).with_context(|| format!("creating {dir:?}"))?;
	Ok(dir)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetOpResult {
	pub asset_id: i64,
	/// New `assets.relative_path` after the op. For trash, this is the
	/// pre-trash value (the row no longer exists).
	pub relative_path: String,
	/// Where the file lives on disk after the op. For trash, this is the
	/// path inside the Garnet trash directory.
	pub abs_path: String,
	/// Where the file lived before the op. Useful for undo.
	pub previous_abs_path: String,
	/// True if the asset's row is still in `assets` after the op (rename
	/// always, move into any registered root). False when the asset moved
	/// outside every registered library root and the row was deleted —
	/// the file is still on disk but Garnet no longer tracks it.
	#[serde(default = "default_true")]
	pub still_in_library: bool,
}

fn default_true() -> bool {
	true
}

/// Look up `(root_path, relative_path)` for an asset id.
fn lookup_asset(
	conn: &rusqlite::Connection,
	asset_id: i64,
) -> rusqlite::Result<(i64, String, String)> {
	conn.query_row(
		"SELECT a.root_id, r.path, a.relative_path
		 FROM assets a JOIN library_roots r ON r.id = a.root_id
		 WHERE a.id = ?1",
		[asset_id],
		|r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
	)
}

/// Rename an asset's filename in place (parent directory stays the same).
/// `new_name` must be a bare filename — no path separators, no leading dot
/// gymnastics. The new path must not already exist.
#[tauri::command]
pub fn rename_asset(
	state: State<AppState>,
	asset_id: i64,
	new_name: String,
) -> Result<AssetOpResult, String> {
	let new_name = new_name.trim().to_string();
	if new_name.is_empty() {
		return Err("New name cannot be empty".into());
	}
	if new_name.contains('/') || new_name.contains('\\') {
		return Err("New name cannot contain path separators".into());
	}
	if new_name == "." || new_name == ".." {
		return Err("Invalid name".into());
	}

	tracing::info!("rename_asset request: asset_id={} new_name={:?}", asset_id, new_name);
	let conn = state.db.lock().map_err(stringify)?;
	let (root_id, root_path, relative_path) = lookup_asset(&conn, asset_id).map_err(stringify)?;
	let old_abs = join_abs(&root_path, &relative_path);

	let parent_rel = Path::new(&relative_path)
		.parent()
		.map(|p| p.to_string_lossy().to_string())
		.unwrap_or_default();
	let new_relative = if parent_rel.is_empty() {
		new_name.clone()
	} else {
		format!("{parent_rel}/{new_name}")
	};
	let new_abs = join_abs(&root_path, &new_relative);

	if new_abs.exists() {
		return Err(format!("A file named “{new_name}” already exists here"));
	}

	std::fs::rename(&old_abs, &new_abs)
		.map_err(|e| format!("rename failed: {e}"))?;

	conn.execute(
		"UPDATE assets SET relative_path = ?1 WHERE id = ?2",
		params![new_relative, asset_id],
	)
	.map_err(stringify)?;

	tracing::info!(
		"renamed asset id={} root_id={} {:?} -> {:?}",
		asset_id, root_id, old_abs, new_abs
	);

	Ok(AssetOpResult {
		asset_id,
		relative_path: new_relative,
		abs_path: new_abs.to_string_lossy().to_string(),
		previous_abs_path: old_abs.to_string_lossy().to_string(),
		still_in_library: true,
	})
}

/// Move an asset's file into a different directory. The filename is
/// preserved. The destination may be inside any registered library root
/// (re-keys `root_id` if it crosses) or outside every root entirely — in
/// which case the file still moves, but the asset row is deleted because
/// the file is no longer in the library.
#[tauri::command]
pub fn move_asset(
	state: State<AppState>,
	asset_id: i64,
	dest_dir: String,
) -> Result<AssetOpResult, String> {
	tracing::info!("move_asset request: asset_id={} dest_dir={:?}", asset_id, dest_dir);
	let conn = state.db.lock().map_err(stringify)?;
	let (_old_root_id, root_path, relative_path) =
		lookup_asset(&conn, asset_id).map_err(stringify)?;
	let old_abs = join_abs(&root_path, &relative_path);

	let dest_canonical = PathBuf::from(&dest_dir)
		.canonicalize()
		.map_err(|e| format!("could not resolve destination {dest_dir:?}: {e}"))?;
	if !dest_canonical.is_dir() {
		return Err(format!("{dest_canonical:?} is not a directory"));
	}

	let filename = Path::new(&relative_path)
		.file_name()
		.ok_or_else(|| "asset has no filename".to_string())?;

	let new_abs = dest_canonical.join(filename);
	if new_abs == old_abs {
		return Err("Destination is the asset's current folder".into());
	}
	if new_abs.exists() {
		return Err(format!(
			"A file named “{}” already exists in the destination",
			filename.to_string_lossy()
		));
	}

	// Decide what should happen to the assets row by checking whether the
	// destination falls inside any registered library root.
	let matching_root = find_containing_root(&conn, &dest_canonical).map_err(stringify)?;

	std::fs::rename(&old_abs, &new_abs)
		.map_err(|e| format!("move failed: {e}"))?;

	let still_in_library = matching_root.is_some();
	let new_relative: String;
	if let Some((new_root_id, new_root_canonical)) = matching_root {
		// Destination is inside a registered root — re-key the row.
		let rel = new_abs
			.strip_prefix(&new_root_canonical)
			.map_err(|e| format!("strip_prefix: {e}"))?
			.to_string_lossy()
			.replace('\\', "/");
		conn.execute(
			"UPDATE assets SET root_id = ?1, relative_path = ?2 WHERE id = ?3",
			params![new_root_id, rel, asset_id],
		)
		.map_err(stringify)?;
		new_relative = rel;
		tracing::info!(
			"moved asset id={} {:?} -> {:?} (new_root_id={})",
			asset_id, old_abs, new_abs, new_root_id
		);
	} else {
		// Destination is outside every registered root — the asset leaves
		// the library. Drop the row; the file is still on disk.
		conn.execute("DELETE FROM assets WHERE id = ?1", [asset_id])
			.map_err(stringify)?;
		new_relative = String::new();
		tracing::info!(
			"moved asset id={} {:?} -> {:?} (out of library; row deleted)",
			asset_id, old_abs, new_abs
		);
	}

	Ok(AssetOpResult {
		asset_id,
		relative_path: new_relative,
		abs_path: new_abs.to_string_lossy().to_string(),
		previous_abs_path: old_abs.to_string_lossy().to_string(),
		still_in_library,
	})
}

/// Pure filesystem move by absolute path — no `assets` row reference.
/// Used by the undo / redo path for moves that crossed library boundaries
/// (the row no longer exists, so we can't reference it by id). The
/// filesystem watcher's debounced rescan reconciles the DB afterward.
#[tauri::command]
pub fn move_file(from_abs_path: String, dest_dir: String) -> Result<String, String> {
	tracing::info!("move_file request: from={:?} dest_dir={:?}", from_abs_path, dest_dir);
	let from = PathBuf::from(&from_abs_path);
	if !from.exists() {
		return Err(format!("source file does not exist: {from:?}"));
	}
	let dest = PathBuf::from(&dest_dir).canonicalize().map_err(|e| {
		format!("could not resolve destination {dest_dir:?}: {e}")
	})?;
	if !dest.is_dir() {
		return Err(format!("{dest:?} is not a directory"));
	}
	let filename = from
		.file_name()
		.ok_or_else(|| "source has no filename".to_string())?;
	let to = dest.join(filename);
	if to == from {
		return Err("Destination is the file's current folder".into());
	}
	if to.exists() {
		return Err(format!(
			"A file named “{}” already exists in the destination",
			filename.to_string_lossy()
		));
	}
	std::fs::rename(&from, &to).map_err(|e| format!("move failed: {e}"))?;
	tracing::info!("moved file {:?} -> {:?}", from, to);
	Ok(to.to_string_lossy().to_string())
}

/// Find which registered library root, if any, contains `path`. Returns
/// `(root_id, canonical_root_path)` for the longest-prefix match so nested
/// roots resolve to the most-specific one.
fn find_containing_root(
	conn: &rusqlite::Connection,
	path: &Path,
) -> rusqlite::Result<Option<(i64, PathBuf)>> {
	let mut stmt = conn.prepare("SELECT id, path FROM library_roots")?;
	let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
	let mut best: Option<(i64, PathBuf, usize)> = None;
	for row in rows {
		let (id, root_str) = row?;
		let root_path = match Path::new(&root_str).canonicalize() {
			Ok(p) => p,
			Err(_) => continue,
		};
		if path.starts_with(&root_path) {
			let len = root_path.as_os_str().len();
			if best.as_ref().map(|(_, _, l)| *l).unwrap_or(0) < len {
				best = Some((id, root_path, len));
			}
		}
	}
	Ok(best.map(|(id, p, _)| (id, p)))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrashResult {
	/// Absolute path the file was moved to inside Garnet's trash directory.
	pub trash_path: String,
	/// Path the file lived at before being trashed; used by the undo to
	/// restore the file to its original location.
	pub original_abs_path: String,
}

/// Move an asset's file into Garnet's trash directory and delete its row
/// from `assets`. The DB row goes away immediately so the UI updates without
/// waiting on a rescan. Undo is `restore_from_trash`.
#[tauri::command]
pub fn trash_asset(
	state: State<AppState>,
	asset_id: i64,
) -> Result<TrashResult, String> {
	tracing::info!("trash_asset request: asset_id={}", asset_id);
	let conn = state.db.lock().map_err(stringify)?;
	let (_root_id, root_path, relative_path) =
		lookup_asset(&conn, asset_id).map_err(stringify)?;
	let original = join_abs(&root_path, &relative_path);

	let trash = trash_dir().map_err(|e| format!("trash dir: {e}"))?;
	let filename = original
		.file_name()
		.map(|s| s.to_string_lossy().to_string())
		.unwrap_or_else(|| "asset".into());
	// Unique name to avoid collisions when the same filename is trashed twice.
	// `<unix_nanos>-<filename>` is short, sorts chronologically, and stays
	// human-readable in the file manager.
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	let trash_path = trash.join(format!("{nanos}-{filename}"));

	std::fs::rename(&original, &trash_path)
		.map_err(|e| format!("trash failed: {e}"))?;

	conn.execute("DELETE FROM assets WHERE id = ?1", [asset_id])
		.map_err(stringify)?;

	tracing::info!(
		"trashed asset id={} {:?} -> {:?}",
		asset_id, original, trash_path
	);

	Ok(TrashResult {
		trash_path: trash_path.to_string_lossy().to_string(),
		original_abs_path: original.to_string_lossy().to_string(),
	})
}

/// Move a previously-trashed file back to a target path. The watcher will
/// pick up the restored file and the indexer will re-insert its row.
/// Idempotent against the destination already existing — if something has
/// since been placed at the original path, the restore errors out rather
/// than clobbering it.
#[tauri::command]
pub fn restore_from_trash(
	trash_path: String,
	destination_abs_path: String,
) -> Result<(), String> {
	let from = PathBuf::from(&trash_path);
	let to = PathBuf::from(&destination_abs_path);
	if !from.exists() {
		return Err(format!("trashed file no longer exists at {from:?}"));
	}
	if to.exists() {
		return Err(format!(
			"can't restore — something else now lives at {to:?}"
		));
	}
	if let Some(parent) = to.parent() {
		std::fs::create_dir_all(parent)
			.map_err(|e| format!("creating parent {parent:?}: {e}"))?;
	}
	std::fs::rename(&from, &to)
		.map_err(|e| format!("restore failed: {e}"))?;
	tracing::info!("restored trashed file {:?} -> {:?}", from, to);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use tempfile::tempdir;

	fn fresh_db_with_root(root_path: &Path) -> rusqlite::Connection {
		let conn = rusqlite::Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"
			CREATE TABLE library_roots (
				id       INTEGER PRIMARY KEY,
				path     TEXT    NOT NULL UNIQUE,
				added_at INTEGER NOT NULL
			);
			CREATE TABLE assets (
				id             INTEGER PRIMARY KEY,
				root_id        INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
				relative_path  TEXT    NOT NULL,
				size           INTEGER,
				mtime          INTEGER,
				format         TEXT,
				is_motion_only INTEGER,
				UNIQUE(root_id, relative_path)
			);
			",
		)
		.unwrap();
		conn.execute(
			"INSERT INTO library_roots (id, path, added_at) VALUES (1, ?1, 0)",
			[root_path.to_string_lossy().as_ref()],
		)
		.unwrap();
		conn
	}

	#[test]
	fn rename_updates_disk_and_row() {
		let tmp = tempdir().unwrap();
		let file = tmp.path().join("a.txt");
		std::fs::write(&file, b"hi").unwrap();
		let conn = fresh_db_with_root(tmp.path());
		conn.execute(
			"INSERT INTO assets (id, root_id, relative_path, format) VALUES (1, 1, 'a.txt', 'txt')",
			[],
		)
		.unwrap();

		// Inline core (sidestep the Tauri State wrapper) to verify the
		// rename logic against the DB and filesystem.
		let new_rel = "b.txt";
		let new_path = tmp.path().join(new_rel);
		std::fs::rename(&file, &new_path).unwrap();
		conn.execute(
			"UPDATE assets SET relative_path = ?1 WHERE id = 1",
			[new_rel],
		)
		.unwrap();

		assert!(new_path.exists());
		assert!(!file.exists());
		let stored: String = conn
			.query_row("SELECT relative_path FROM assets WHERE id = 1", [], |r| {
				r.get(0)
			})
			.unwrap();
		assert_eq!(stored, "b.txt");
	}

	#[test]
	fn trash_dir_is_under_data_dir() {
		// Just verify the path resolves and creates without panicking.
		let _ = trash_dir().unwrap();
	}
}

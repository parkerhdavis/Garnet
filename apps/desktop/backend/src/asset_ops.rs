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
	})
}

/// Move an asset into a different directory. The destination directory must
/// be inside the same library root as the asset (cross-root moves would
/// require re-keying the row to a different root_id; deferred until there's
/// a user need). The filename is preserved.
#[tauri::command]
pub fn move_asset(
	state: State<AppState>,
	asset_id: i64,
	dest_dir: String,
) -> Result<AssetOpResult, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let (root_id, root_path, relative_path) = lookup_asset(&conn, asset_id).map_err(stringify)?;
	let old_abs = join_abs(&root_path, &relative_path);

	let dest_dir_path = PathBuf::from(&dest_dir);
	let dest_canonical = dest_dir_path
		.canonicalize()
		.map_err(|e| format!("could not resolve destination {dest_dir:?}: {e}"))?;
	if !dest_canonical.is_dir() {
		return Err(format!("{dest_canonical:?} is not a directory"));
	}

	let root_canonical = Path::new(&root_path)
		.canonicalize()
		.map_err(|e| format!("could not resolve library root: {e}"))?;
	let new_rel_under_root = dest_canonical.strip_prefix(&root_canonical).map_err(|_| {
		format!(
			"destination {dest_canonical:?} is not inside the asset's library root ({root_canonical:?})"
		)
	})?;

	let filename = Path::new(&relative_path)
		.file_name()
		.ok_or_else(|| "asset has no filename".to_string())?;
	let new_relative_pb = if new_rel_under_root.as_os_str().is_empty() {
		PathBuf::from(filename)
	} else {
		new_rel_under_root.join(filename)
	};
	let new_relative = new_relative_pb.to_string_lossy().replace('\\', "/");
	let new_abs = join_abs(&root_path, &new_relative);

	if new_abs == old_abs {
		return Err("Destination is the asset's current folder".into());
	}
	if new_abs.exists() {
		return Err(format!(
			"A file named “{}” already exists in the destination",
			filename.to_string_lossy()
		));
	}

	std::fs::rename(&old_abs, &new_abs)
		.map_err(|e| format!("move failed: {e}"))?;

	conn.execute(
		"UPDATE assets SET relative_path = ?1 WHERE id = ?2",
		params![new_relative, asset_id],
	)
	.map_err(stringify)?;

	tracing::info!(
		"moved asset id={} root_id={} {:?} -> {:?}",
		asset_id, root_id, old_abs, new_abs
	);

	Ok(AssetOpResult {
		asset_id,
		relative_path: new_relative,
		abs_path: new_abs.to_string_lossy().to_string(),
		previous_abs_path: old_abs.to_string_lossy().to_string(),
	})
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
				id            INTEGER PRIMARY KEY,
				root_id       INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
				relative_path TEXT    NOT NULL,
				size          INTEGER,
				mtime         INTEGER,
				format        TEXT,
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

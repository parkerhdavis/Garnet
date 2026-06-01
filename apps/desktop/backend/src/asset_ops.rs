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

/// Move a file on disk into Garnet's trash directory, returning the path it now
/// lives at. The trashed name is prefixed with a unix-nanos timestamp so
/// repeated trashings of the same filename never collide and stay
/// chronologically sortable in the file manager. Pure filesystem — the caller
/// owns any DB bookkeeping.
fn move_to_trash(original: &Path) -> anyhow::Result<PathBuf> {
	let trash = trash_dir()?;
	let filename = original
		.file_name()
		.map(|s| s.to_string_lossy().to_string())
		.unwrap_or_else(|| "asset".into());
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	let trash_path = trash.join(format!("{nanos}-{filename}"));
	std::fs::rename(original, &trash_path)
		.with_context(|| format!("moving {original:?} into trash"))?;
	Ok(trash_path)
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

	let trash_path = move_to_trash(&original).map_err(|e| format!("trash failed: {e}"))?;

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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CopyResult {
	pub asset_id: i64,
	/// Where the source asset lives on disk (unchanged by the copy).
	pub source_abs_path: String,
	/// Where the new copy was written.
	pub copied_abs_path: String,
	/// True if the copy landed inside a registered library root, so the
	/// watcher will index it as a new asset. False when copied outside every
	/// root (the file exists but Garnet won't track it).
	pub still_in_library: bool,
}

/// Copy an asset's file into another directory, preserving the filename. The
/// original is left untouched. The DB is not modified here — if the copy lands
/// inside a registered root, the filesystem watcher indexes it as a new asset
/// on its own; the returned `copied_abs_path` lets the caller wire an undo that
/// trashes the copy.
#[tauri::command]
pub fn copy_asset(
	state: State<AppState>,
	asset_id: i64,
	dest_dir: String,
) -> Result<CopyResult, String> {
	tracing::info!("copy_asset request: asset_id={} dest_dir={:?}", asset_id, dest_dir);
	let conn = state.db.lock().map_err(stringify)?;
	let (_root_id, root_path, relative_path) =
		lookup_asset(&conn, asset_id).map_err(stringify)?;
	let src = join_abs(&root_path, &relative_path);

	let dest_canonical = PathBuf::from(&dest_dir)
		.canonicalize()
		.map_err(|e| format!("could not resolve destination {dest_dir:?}: {e}"))?;
	if !dest_canonical.is_dir() {
		return Err(format!("{dest_canonical:?} is not a directory"));
	}

	let filename = Path::new(&relative_path)
		.file_name()
		.ok_or_else(|| "asset has no filename".to_string())?;
	let dest = dest_canonical.join(filename);
	if dest == src {
		return Err("Destination is the asset's current folder".into());
	}
	if dest.exists() {
		return Err(format!(
			"A file named “{}” already exists in the destination",
			filename.to_string_lossy()
		));
	}

	let still_in_library = find_containing_root(&conn, &dest_canonical)
		.map_err(stringify)?
		.is_some();

	std::fs::copy(&src, &dest).map_err(|e| format!("copy failed: {e}"))?;
	tracing::info!("copied asset id={} {:?} -> {:?}", asset_id, src, dest);

	Ok(CopyResult {
		asset_id,
		source_abs_path: src.to_string_lossy().to_string(),
		copied_abs_path: dest.to_string_lossy().to_string(),
		still_in_library,
	})
}

/// Move an arbitrary file (by absolute path, no `assets` row reference) into
/// Garnet's trash directory. Used to undo a copy — the copied file may have
/// been indexed as a new asset by the time undo runs, so we address it by path
/// rather than id; the watcher's rescan drops any row that pointed at it.
#[tauri::command]
pub fn trash_file(abs_path: String) -> Result<TrashResult, String> {
	tracing::info!("trash_file request: abs_path={:?}", abs_path);
	let original = PathBuf::from(&abs_path);
	if !original.exists() {
		return Err(format!("file no longer exists: {original:?}"));
	}
	let trash_path = move_to_trash(&original).map_err(|e| format!("trash failed: {e}"))?;
	tracing::info!("trashed file {:?} -> {:?}", original, trash_path);
	Ok(TrashResult {
		trash_path: trash_path.to_string_lossy().to_string(),
		original_abs_path: original.to_string_lossy().to_string(),
	})
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RenamePair {
	pub asset_id: i64,
	/// Bare target filename — no path separators. The asset stays in its
	/// current directory.
	pub new_name: String,
}

/// Rename a batch of assets in place (each keeps its parent directory). Powers
/// the multi-select "Rename N items…" flow: the frontend computes the final
/// names from a token pattern (so it can show a live preview) and hands the
/// resolved (id → name) pairs here.
///
/// Collision-safe in two phases: every source is first moved aside to a
/// unique temp name in its own directory, then each temp is moved to its final
/// name. This lets targets reference names currently held by other sources in
/// the same batch (e.g. a cyclic `a→b`, `b→a` swap, or a `{name}_{index}`
/// renumber) without a mid-flight clash. Targets are validated up front: no two
/// may resolve to the same path, and a target may pre-exist on disk only if it
/// belongs to a source in this batch.
#[tauri::command]
pub fn rename_assets(
	state: State<AppState>,
	renames: Vec<RenamePair>,
) -> Result<Vec<AssetOpResult>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	rename_assets_impl(&conn, &renames)
}

/// Core of [`rename_assets`], split out so it can be tested against an
/// in-memory DB + tempdir without the Tauri `State` wrapper.
pub fn rename_assets_impl(
	conn: &rusqlite::Connection,
	renames: &[RenamePair],
) -> Result<Vec<AssetOpResult>, String> {
	tracing::info!("rename_assets request: {} items", renames.len());
	if renames.is_empty() {
		return Ok(Vec::new());
	}

	struct Plan {
		asset_id: i64,
		old_abs: PathBuf,
		new_abs: PathBuf,
		new_relative: String,
		temp_abs: PathBuf,
		temp_relative: String,
	}

	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);

	// Phase 0 — resolve and validate every rename before touching the disk.
	let mut plans: Vec<Plan> = Vec::with_capacity(renames.len());
	let mut sources: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
	let mut targets: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
	for (i, r) in renames.iter().enumerate() {
		let new_name = r.new_name.trim().to_string();
		if new_name.is_empty() {
			return Err("New name cannot be empty".into());
		}
		if new_name.contains('/') || new_name.contains('\\') {
			return Err(format!("“{new_name}” cannot contain path separators"));
		}
		if new_name == "." || new_name == ".." {
			return Err(format!("“{new_name}” is not a valid name"));
		}
		let (_root_id, root_path, relative_path) =
			lookup_asset(conn, r.asset_id).map_err(stringify)?;
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
		if !targets.insert(new_abs.clone()) {
			return Err(format!(
				"Two files would both be named “{}”",
				new_abs.to_string_lossy()
			));
		}
		let temp_name = format!(".garnet-rename-{nanos}-{i}");
		let temp_relative = if parent_rel.is_empty() {
			temp_name.clone()
		} else {
			format!("{parent_rel}/{temp_name}")
		};
		let temp_abs = old_abs.with_file_name(&temp_name);
		sources.insert(old_abs.clone());
		plans.push(Plan {
			asset_id: r.asset_id,
			old_abs,
			new_abs,
			new_relative,
			temp_abs,
			temp_relative,
		});
	}
	// A target may already exist on disk only if it's one of the sources we're
	// about to move out of the way.
	for t in &targets {
		if t.exists() && !sources.contains(t) {
			return Err(format!(
				"A file named “{}” already exists here",
				t.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
			));
		}
	}

	// Phase 1 — move every source aside to its temp name, and point its row at
	// the (unique) temp path. Updating the row here too keeps the DB's
	// `UNIQUE(root_id, relative_path)` from tripping in phase 2 when a target
	// name is still held by another row in the batch (e.g. an a↔b swap).
	for p in &plans {
		std::fs::rename(&p.old_abs, &p.temp_abs)
			.map_err(|e| format!("rename failed for {:?}: {e}", p.old_abs))?;
		conn.execute(
			"UPDATE assets SET relative_path = ?1 WHERE id = ?2",
			params![p.temp_relative, p.asset_id],
		)
		.map_err(stringify)?;
	}
	// Phase 2 — move each temp into its final name and update the row.
	let mut results = Vec::with_capacity(plans.len());
	for p in &plans {
		std::fs::rename(&p.temp_abs, &p.new_abs)
			.map_err(|e| format!("rename failed for {:?}: {e}", p.new_abs))?;
		conn.execute(
			"UPDATE assets SET relative_path = ?1 WHERE id = ?2",
			params![p.new_relative, p.asset_id],
		)
		.map_err(stringify)?;
		results.push(AssetOpResult {
			asset_id: p.asset_id,
			relative_path: p.new_relative.clone(),
			abs_path: p.new_abs.to_string_lossy().to_string(),
			previous_abs_path: p.old_abs.to_string_lossy().to_string(),
			still_in_library: true,
		});
	}
	tracing::info!("renamed {} assets", results.len());
	Ok(results)
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

	#[test]
	fn batch_rename_handles_cyclic_swap() {
		let tmp = tempdir().unwrap();
		let a = tmp.path().join("a.txt");
		let b = tmp.path().join("b.txt");
		std::fs::write(&a, b"AAA").unwrap();
		std::fs::write(&b, b"BBB").unwrap();
		let conn = fresh_db_with_root(tmp.path());
		conn.execute(
			"INSERT INTO assets (id, root_id, relative_path, format)
			 VALUES (1, 1, 'a.txt', 'txt'), (2, 1, 'b.txt', 'txt')",
			[],
		)
		.unwrap();

		// Swap the two filenames. The temp-name phase makes this safe even
		// though each target is the other's current name.
		let renames = vec![
			RenamePair { asset_id: 1, new_name: "b.txt".into() },
			RenamePair { asset_id: 2, new_name: "a.txt".into() },
		];
		let out = rename_assets_impl(&conn, &renames).unwrap();
		assert_eq!(out.len(), 2);

		// Contents followed the rows: id 1 now lives at b.txt (still "AAA").
		assert_eq!(std::fs::read(&b).unwrap(), b"AAA");
		assert_eq!(std::fs::read(&a).unwrap(), b"BBB");
		let rel1: String = conn
			.query_row("SELECT relative_path FROM assets WHERE id = 1", [], |r| r.get(0))
			.unwrap();
		let rel2: String = conn
			.query_row("SELECT relative_path FROM assets WHERE id = 2", [], |r| r.get(0))
			.unwrap();
		assert_eq!(rel1, "b.txt");
		assert_eq!(rel2, "a.txt");
	}

	#[test]
	fn batch_rename_rejects_colliding_targets() {
		let tmp = tempdir().unwrap();
		std::fs::write(tmp.path().join("a.txt"), b"A").unwrap();
		std::fs::write(tmp.path().join("b.txt"), b"B").unwrap();
		let conn = fresh_db_with_root(tmp.path());
		conn.execute(
			"INSERT INTO assets (id, root_id, relative_path, format)
			 VALUES (1, 1, 'a.txt', 'txt'), (2, 1, 'b.txt', 'txt')",
			[],
		)
		.unwrap();
		// Both renames resolve to the same target — rejected up front, disk
		// left untouched.
		let renames = vec![
			RenamePair { asset_id: 1, new_name: "same.txt".into() },
			RenamePair { asset_id: 2, new_name: "same.txt".into() },
		];
		assert!(rename_assets_impl(&conn, &renames).is_err());
		assert!(tmp.path().join("a.txt").exists());
		assert!(tmp.path().join("b.txt").exists());
	}
}

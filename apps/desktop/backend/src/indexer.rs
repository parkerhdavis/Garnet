// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library scanner: walks a library root, populates the `assets` table, and
//! extracts per-format metadata into `asset_metadata`. Handles three change
//! shapes between scans:
//!
//! - **Unchanged** — `(size, mtime)` matches the existing row at the same
//!   relative path; nothing to do.
//! - **Modified** — same path, different `(size, mtime)`; re-hash, refresh
//!   `format`/`size`/`mtime`/`content_hash`, drop+re-extract metadata.
//! - **Renamed/moved** — file at a new path whose `content_hash` matches an
//!   unseen existing row; update that row's `relative_path` (metadata
//!   preserved — the underlying content didn't change).
//! - **Deleted** — rows present before the scan whose paths weren't visited;
//!   removed via `DELETE`, which also cascades `asset_metadata`,
//!   `asset_tags`, and `collection_assets`.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ScanReport {
	pub root_id: i64,
	pub files_seen: u64,
	pub files_inserted: u64,
	pub files_updated: u64,
	pub files_renamed: u64,
	pub files_deleted: u64,
	pub files_skipped: u64,
	pub metadata_extracted: u64,
}

#[derive(Debug, Clone)]
struct ExistingRow {
	id: i64,
	size: Option<i64>,
	mtime: Option<i64>,
	content_hash: Option<String>,
}

/// Scan a library root, syncing the `assets` table to reflect the current
/// filesystem state. Returns counters describing what changed.
pub fn scan_root(conn: &Connection, root_id: i64, root_path: &Path) -> rusqlite::Result<ScanReport> {
	let mut report = ScanReport {
		root_id,
		..Default::default()
	};

	// Snapshot existing rows for this root, keyed by relative_path.
	let mut by_path: HashMap<String, ExistingRow> = HashMap::new();
	{
		let mut stmt = conn.prepare(
			"SELECT id, relative_path, size, mtime, content_hash FROM assets WHERE root_id = ?1",
		)?;
		let rows = stmt.query_map([root_id], |r| {
			Ok((
				r.get::<_, String>(1)?,
				ExistingRow {
					id: r.get(0)?,
					size: r.get(2)?,
					mtime: r.get(3)?,
					content_hash: r.get(4)?,
				},
			))
		})?;
		for row in rows {
			let (rel, existing) = row?;
			by_path.insert(rel, existing);
		}
	}

	// Build a hash → id index for unseen rows so renames can be detected in
	// O(1). Populated lazily once we've reduced `by_path` to "unseen" only.
	let mut seen_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

	let tx = conn.unchecked_transaction()?;
	{
		for entry in WalkDir::new(root_path)
			.follow_links(false)
			.into_iter()
			.filter_map(|e| e.ok())
		{
			if !entry.file_type().is_file() {
				continue;
			}
			report.files_seen += 1;

			let abs = entry.path();
			let relative = match abs.strip_prefix(root_path) {
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

			let existing = by_path.get(&relative).cloned();

			if let Some(row) = existing {
				if row.size == Some(size) && row.mtime == mtime {
					// Unchanged — fast path.
					seen_ids.insert(row.id);
					continue;
				}

				// Same path, different size/mtime → modified.
				let hash = hash_file(abs).ok();
				tx.execute(
					"UPDATE assets SET size = ?1, mtime = ?2, format = ?3, content_hash = ?4 WHERE id = ?5",
					params![size, mtime, format, hash, row.id],
				)?;
				refresh_metadata(&tx, row.id, abs, format.as_deref())?;
				report.files_updated += 1;
				report.metadata_extracted += 1;
				seen_ids.insert(row.id);
				continue;
			}

			// File at a path we don't have a row for. Maybe a brand-new asset,
			// maybe a rename of an unseen row.
			let hash = hash_file(abs).ok();
			let rename_target = match &hash {
				Some(h) => find_unseen_by_hash(&by_path, &seen_ids, h),
				None => None,
			};

			if let Some(target_id) = rename_target {
				tx.execute(
					"UPDATE assets SET relative_path = ?1, size = ?2, mtime = ?3, format = ?4 WHERE id = ?5",
					params![relative, size, mtime, format, target_id],
				)?;
				report.files_renamed += 1;
				seen_ids.insert(target_id);
				continue;
			}

			// Brand-new insert.
			tx.execute(
				"INSERT INTO assets (root_id, relative_path, size, mtime, format, content_hash)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
				params![root_id, relative, size, mtime, format, hash],
			)?;
			let new_id = tx.last_insert_rowid();
			refresh_metadata(&tx, new_id, abs, format.as_deref())?;
			// Seed user-editable metadata from the file's xattr/ADS mirror, if
			// any. Lets metadata that travelled with the file (copied from
			// another machine, restored from backup) repopulate the DB without
			// the user re-entering it. No-op when no mirror is present.
			crate::garnet_metadata::seed_from_mirror(&tx, new_id, abs);
			report.files_inserted += 1;
			report.metadata_extracted += 1;
			seen_ids.insert(new_id);
		}

		// Anything in by_path whose id wasn't seen is a deletion.
		for (_rel, row) in by_path.iter() {
			if !seen_ids.contains(&row.id) {
				tx.execute("DELETE FROM assets WHERE id = ?1", params![row.id])?;
				report.files_deleted += 1;
			}
		}
	}
	tx.commit()?;

	tracing::info!(
		"scan complete: root_id={} seen={} inserted={} updated={} renamed={} deleted={} skipped={}",
		root_id,
		report.files_seen,
		report.files_inserted,
		report.files_updated,
		report.files_renamed,
		report.files_deleted,
		report.files_skipped,
	);
	Ok(report)
}

fn find_unseen_by_hash(
	by_path: &HashMap<String, ExistingRow>,
	seen: &std::collections::HashSet<i64>,
	hash: &str,
) -> Option<i64> {
	for row in by_path.values() {
		if seen.contains(&row.id) {
			continue;
		}
		if row.content_hash.as_deref() == Some(hash) {
			return Some(row.id);
		}
	}
	None
}

fn hash_file(path: &Path) -> std::io::Result<String> {
	let f = File::open(path)?;
	let mut reader = BufReader::with_capacity(64 * 1024, f);
	let mut hasher = blake3::Hasher::new();
	let mut buf = [0u8; 64 * 1024];
	loop {
		let n = reader.read(&mut buf)?;
		if n == 0 {
			break;
		}
		hasher.update(&buf[..n]);
	}
	Ok(hasher.finalize().to_hex().to_string())
}

fn refresh_metadata(
	conn: &Connection,
	asset_id: i64,
	abs_path: &Path,
	format: Option<&str>,
) -> rusqlite::Result<()> {
	// Drop any previous extraction for this asset; we re-derive everything.
	conn.execute(
		"DELETE FROM asset_metadata WHERE asset_id = ?1",
		params![asset_id],
	)?;

	let mut pairs: Vec<(&str, String)> = Vec::new();

	if let Some(ext) = format {
		match ext {
			"png" | "jpg" | "jpeg" | "gif" | "bmp" | "tif" | "tiff" | "webp" => {
				if let Ok((w, h)) = image::image_dimensions(abs_path) {
					pairs.push(("image.width", w.to_string()));
					pairs.push(("image.height", h.to_string()));
				}
			}
			_ => {}
		}
		if matches!(ext, "jpg" | "jpeg" | "tif" | "tiff") {
			if let Some(exif_pairs) = read_exif(abs_path) {
				for (k, v) in exif_pairs {
					pairs.push((k, v));
				}
			}
		}
	}

	if !pairs.is_empty() {
		let mut stmt = conn
			.prepare("INSERT INTO asset_metadata (asset_id, key, value) VALUES (?1, ?2, ?3)")?;
		for (k, v) in pairs {
			stmt.execute(params![asset_id, k, v])?;
		}
	}
	Ok(())
}

fn read_exif(path: &Path) -> Option<Vec<(&'static str, String)>> {
	let file = File::open(path).ok()?;
	let mut br = BufReader::new(file);
	let reader = exif::Reader::new().read_from_container(&mut br).ok()?;
	let mut out: Vec<(&'static str, String)> = Vec::new();
	for (key, tag) in &[
		("exif.date_original", exif::Tag::DateTimeOriginal),
		("exif.date", exif::Tag::DateTime),
		("exif.make", exif::Tag::Make),
		("exif.model", exif::Tag::Model),
		("exif.exposure_time", exif::Tag::ExposureTime),
		("exif.f_number", exif::Tag::FNumber),
		("exif.iso", exif::Tag::PhotographicSensitivity),
		("exif.focal_length", exif::Tag::FocalLength),
		("exif.lens_model", exif::Tag::LensModel),
		("exif.orientation", exif::Tag::Orientation),
	] {
		if let Some(field) = reader.get_field(*tag, exif::In::PRIMARY) {
			let v = field.display_value().to_string();
			if !v.is_empty() {
				out.push((*key, v));
			}
		}
	}
	if out.is_empty() {
		None
	} else {
		Some(out)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::db::MIGRATIONS;

	fn fresh_db() -> Connection {
		let conn = Connection::open_in_memory().unwrap();
		// Apply migrations directly to keep tests self-contained.
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
	fn detects_new_files() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
		std::fs::write(tmp.path().join("b.txt"), b"world").unwrap();

		let conn = fresh_db();
		let root_id = register_root(&conn, tmp.path());
		let r = scan_root(&conn, root_id, tmp.path()).unwrap();
		assert_eq!(r.files_inserted, 2);
		assert_eq!(r.files_seen, 2);
	}

	#[test]
	fn no_op_rescan_is_unchanged() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
		let conn = fresh_db();
		let root_id = register_root(&conn, tmp.path());
		scan_root(&conn, root_id, tmp.path()).unwrap();
		let r2 = scan_root(&conn, root_id, tmp.path()).unwrap();
		assert_eq!(r2.files_inserted, 0);
		assert_eq!(r2.files_updated, 0);
		assert_eq!(r2.files_deleted, 0);
	}

	#[test]
	fn detects_renames_via_content_hash() {
		let tmp = tempfile::tempdir().unwrap();
		let a = tmp.path().join("a.txt");
		std::fs::write(&a, b"some content").unwrap();
		let conn = fresh_db();
		let root_id = register_root(&conn, tmp.path());
		scan_root(&conn, root_id, tmp.path()).unwrap();

		// Move to a new name; same content, same hash.
		let b = tmp.path().join("renamed.txt");
		std::fs::rename(&a, &b).unwrap();
		let r2 = scan_root(&conn, root_id, tmp.path()).unwrap();
		assert_eq!(r2.files_renamed, 1, "expected one rename");
		assert_eq!(r2.files_inserted, 0);
		assert_eq!(r2.files_deleted, 0);

		// Row count unchanged, path updated.
		let count: i64 = conn
			.query_row("SELECT COUNT(*) FROM assets WHERE root_id = ?1", [root_id], |r| r.get(0))
			.unwrap();
		assert_eq!(count, 1);
		let path: String = conn
			.query_row(
				"SELECT relative_path FROM assets WHERE root_id = ?1",
				[root_id],
				|r| r.get(0),
			)
			.unwrap();
		assert_eq!(path, "renamed.txt");
	}

	#[test]
	fn detects_deletions() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::write(tmp.path().join("a.txt"), b"a").unwrap();
		std::fs::write(tmp.path().join("b.txt"), b"b").unwrap();
		let conn = fresh_db();
		let root_id = register_root(&conn, tmp.path());
		scan_root(&conn, root_id, tmp.path()).unwrap();

		std::fs::remove_file(tmp.path().join("a.txt")).unwrap();
		let r2 = scan_root(&conn, root_id, tmp.path()).unwrap();
		assert_eq!(r2.files_deleted, 1);
		let count: i64 = conn
			.query_row("SELECT COUNT(*) FROM assets WHERE root_id = ?1", [root_id], |r| r.get(0))
			.unwrap();
		assert_eq!(count, 1);
	}

	#[test]
	fn detects_modifications() {
		let tmp = tempfile::tempdir().unwrap();
		let a = tmp.path().join("a.txt");
		std::fs::write(&a, b"old content").unwrap();
		let conn = fresh_db();
		let root_id = register_root(&conn, tmp.path());
		scan_root(&conn, root_id, tmp.path()).unwrap();

		// Bump the mtime artificially so the fast-path check fires modified.
		std::thread::sleep(std::time::Duration::from_millis(1100));
		std::fs::write(&a, b"new content with different length").unwrap();
		let r2 = scan_root(&conn, root_id, tmp.path()).unwrap();
		assert_eq!(r2.files_updated, 1);
		assert_eq!(r2.files_inserted, 0);
	}

	#[test]
	fn cascades_metadata_on_delete() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
		let conn = fresh_db();
		let root_id = register_root(&conn, tmp.path());
		scan_root(&conn, root_id, tmp.path()).unwrap();

		let asset_id: i64 = conn
			.query_row("SELECT id FROM assets LIMIT 1", [], |r| r.get(0))
			.unwrap();
		conn.execute(
			"INSERT INTO asset_metadata (asset_id, key, value) VALUES (?1, 'k', 'v')",
			[asset_id],
		)
		.unwrap();

		std::fs::remove_file(tmp.path().join("a.txt")).unwrap();
		scan_root(&conn, root_id, tmp.path()).unwrap();

		let md_count: i64 = conn
			.query_row("SELECT COUNT(*) FROM asset_metadata", [], |r| r.get(0))
			.unwrap();
		assert_eq!(md_count, 0);
	}
}

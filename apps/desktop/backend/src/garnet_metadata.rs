// SPDX-License-Identifier: AGPL-3.0-or-later
//! User-editable per-asset metadata. The DB is authoritative; we *also*
//! mirror to the file's extended attributes (Linux/macOS) or NTFS alternate
//! data stream (Windows) so metadata travels with the file when copied to
//! another machine. Mirror failures are non-fatal — many filesystems strip
//! xattrs silently (FAT32, exFAT, cloud sync, archives without `--xattrs`),
//! so we log + continue.
//!
//! Tags are not a separate concept: they're values of the well-known `tags`
//! key.

use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GarnetMetadataEntry {
	pub key: String,
	pub values: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ValueCount {
	pub value: String,
	pub count: i64,
}

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

fn now_secs() -> i64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs() as i64)
		.unwrap_or(0)
}

/// Build the absolute path for an asset id. Returned even if the file no
/// longer exists on disk — the mirror layer handles missing files gracefully.
fn asset_abs_path(conn: &Connection, asset_id: i64) -> rusqlite::Result<Option<PathBuf>> {
	let row: Option<(String, String)> = conn
		.query_row(
			"SELECT r.path, a.relative_path
			 FROM assets a JOIN library_roots r ON r.id = a.root_id
			 WHERE a.id = ?1",
			[asset_id],
			|r| Ok((r.get(0)?, r.get(1)?)),
		)
		.ok();
	Ok(row.map(|(root, rel)| Path::new(&root).join(rel)))
}

/// All garnet metadata for an asset, grouped by key. Keys are sorted; values
/// inside a key follow the stored `position`, then alphabetical as a
/// tiebreaker (so deterministic for tests + UI).
pub fn list_for_asset(
	conn: &Connection,
	asset_id: i64,
) -> rusqlite::Result<Vec<GarnetMetadataEntry>> {
	let mut stmt = conn.prepare(
		"SELECT key, value FROM garnet_metadata
		 WHERE asset_id = ?1
		 ORDER BY key COLLATE NOCASE ASC, position ASC, value COLLATE NOCASE ASC",
	)?;
	let mut out: Vec<GarnetMetadataEntry> = Vec::new();
	let rows = stmt.query_map([asset_id], |r| {
		Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
	})?;
	for row in rows {
		let (k, v) = row?;
		match out.last_mut() {
			Some(last) if last.key == k => last.values.push(v),
			_ => out.push(GarnetMetadataEntry { key: k, values: vec![v] }),
		}
	}
	Ok(out)
}

/// Replace every value for `key` on `asset_id` with `values`. Insert order is
/// preserved via the `position` column. Empty `values` is equivalent to
/// removing the key entirely.
pub fn set_key(
	conn: &Connection,
	asset_id: i64,
	key: &str,
	values: &[String],
) -> rusqlite::Result<()> {
	let key = key.trim();
	if key.is_empty() {
		return Err(rusqlite::Error::InvalidParameterName(
			"key cannot be empty".into(),
		));
	}
	let tx = conn.unchecked_transaction()?;
	tx.execute(
		"DELETE FROM garnet_metadata WHERE asset_id = ?1 AND key = ?2",
		params![asset_id, key],
	)?;
	let now = now_secs();
	for (i, v) in values.iter().enumerate() {
		let v = v.trim();
		if v.is_empty() {
			continue;
		}
		tx.execute(
			"INSERT OR IGNORE INTO garnet_metadata
			 (asset_id, key, value, position, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
			params![asset_id, key, v, i as i64, now],
		)?;
	}
	tx.commit()?;
	Ok(())
}

/// Add a single value to a key. Idempotent — if (asset, key, value) already
/// exists, the call is a no-op aside from bumping `updated_at`. Appends to
/// the end of the position order.
pub fn add_value(
	conn: &Connection,
	asset_id: i64,
	key: &str,
	value: &str,
) -> rusqlite::Result<()> {
	let key = key.trim();
	let value = value.trim();
	if key.is_empty() || value.is_empty() {
		return Err(rusqlite::Error::InvalidParameterName(
			"key/value cannot be empty".into(),
		));
	}
	let next_position: i64 = conn
		.query_row(
			"SELECT COALESCE(MAX(position), -1) + 1 FROM garnet_metadata
			 WHERE asset_id = ?1 AND key = ?2",
			params![asset_id, key],
			|r| r.get(0),
		)
		.unwrap_or(0);
	let now = now_secs();
	conn.execute(
		"INSERT INTO garnet_metadata
		 (asset_id, key, value, position, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
		 ON CONFLICT(asset_id, key, value) DO UPDATE SET updated_at = ?5",
		params![asset_id, key, value, next_position, now],
	)?;
	Ok(())
}

pub fn remove_value(
	conn: &Connection,
	asset_id: i64,
	key: &str,
	value: &str,
) -> rusqlite::Result<()> {
	conn.execute(
		"DELETE FROM garnet_metadata WHERE asset_id = ?1 AND key = ?2 AND value = ?3",
		params![asset_id, key, value],
	)?;
	Ok(())
}

pub fn remove_key(conn: &Connection, asset_id: i64, key: &str) -> rusqlite::Result<()> {
	conn.execute(
		"DELETE FROM garnet_metadata WHERE asset_id = ?1 AND key = ?2",
		params![asset_id, key],
	)?;
	Ok(())
}

/// Distinct values for a key across the whole library, with asset counts.
/// Used by FilterBar to render the tag chip row and similar.
pub fn distinct_values_for_key(
	conn: &Connection,
	key: &str,
) -> rusqlite::Result<Vec<ValueCount>> {
	let mut stmt = conn.prepare(
		"SELECT value, COUNT(DISTINCT asset_id) AS c
		 FROM garnet_metadata WHERE key = ?1
		 GROUP BY value
		 ORDER BY value COLLATE NOCASE ASC",
	)?;
	let rows = stmt
		.query_map([key], |r| {
			Ok(ValueCount {
				value: r.get(0)?,
				count: r.get(1)?,
			})
		})?
		.collect::<Result<Vec<_>, _>>()?;
	Ok(rows)
}

/// Read the current full DB state for an asset and write it to the file's
/// xattr/ADS mirror. Failures are logged and swallowed.
pub fn sync_mirror_for_asset(conn: &Connection, asset_id: i64) {
	let path = match asset_abs_path(conn, asset_id) {
		Ok(Some(p)) => p,
		_ => return,
	};
	let entries = match list_for_asset(conn, asset_id) {
		Ok(e) => e,
		Err(e) => {
			tracing::warn!("garnet_metadata: list_for_asset({asset_id}) failed: {e}");
			return;
		}
	};
	let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
	for e in entries {
		map.insert(e.key, e.values);
	}
	mirror::write_blob(&path, &map);
}

/// Read xattr/ADS blob for a freshly-indexed file and seed garnet_metadata
/// rows. Called from the indexer on insert. If no blob is present (typical
/// for files that have never been touched by Garnet), this is a no-op.
pub fn seed_from_mirror(conn: &Connection, asset_id: i64, abs: &Path) {
	let map = match mirror::read_blob(abs) {
		Some(m) if !m.is_empty() => m,
		_ => return,
	};
	for (key, values) in map {
		if let Err(e) = set_key(conn, asset_id, &key, &values) {
			tracing::warn!(
				"garnet_metadata: seed_from_mirror set_key({asset_id}, {key:?}) failed: {e}"
			);
		}
	}
}

// ---- Tauri commands ----------------------------------------------------

#[tauri::command]
pub fn list_garnet_metadata(
	state: State<AppState>,
	asset_id: i64,
) -> Result<Vec<GarnetMetadataEntry>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	list_for_asset(&conn, asset_id).map_err(stringify)
}

#[tauri::command]
pub fn set_garnet_metadata_key(
	state: State<AppState>,
	asset_id: i64,
	key: String,
	values: Vec<String>,
) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	set_key(&conn, asset_id, &key, &values).map_err(stringify)?;
	sync_mirror_for_asset(&conn, asset_id);
	Ok(())
}

#[tauri::command]
pub fn add_garnet_metadata_value(
	state: State<AppState>,
	asset_id: i64,
	key: String,
	value: String,
) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	add_value(&conn, asset_id, &key, &value).map_err(stringify)?;
	sync_mirror_for_asset(&conn, asset_id);
	Ok(())
}

#[tauri::command]
pub fn remove_garnet_metadata_value(
	state: State<AppState>,
	asset_id: i64,
	key: String,
	value: String,
) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	remove_value(&conn, asset_id, &key, &value).map_err(stringify)?;
	sync_mirror_for_asset(&conn, asset_id);
	Ok(())
}

#[tauri::command]
pub fn remove_garnet_metadata_key(
	state: State<AppState>,
	asset_id: i64,
	key: String,
) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	remove_key(&conn, asset_id, &key).map_err(stringify)?;
	sync_mirror_for_asset(&conn, asset_id);
	Ok(())
}

#[tauri::command]
pub fn list_garnet_metadata_values_for_key(
	state: State<AppState>,
	key: String,
) -> Result<Vec<ValueCount>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	distinct_values_for_key(&conn, &key).map_err(stringify)
}

// ---- Mirror implementation --------------------------------------------

/// File-side mirror of the garnet_metadata blob. The whole per-asset map is
/// stored as a single JSON object in one xattr (`user.garnet` on Linux/macOS)
/// or one ADS (`:garnet` on Windows NTFS). Storing one blob rather than one
/// attr per key simplifies enumeration on Windows (no `FindFirstStreamW`
/// needed) and keeps writes atomic at the platform level.
pub mod mirror {
	use super::*;

	const ATTR_NAME: &str = "user.garnet";
	#[cfg(windows)]
	const ADS_NAME: &str = "garnet";

	/// Serialize the map as canonical JSON. Empty map → empty bytes (mirror
	/// is removed rather than left with `{}`).
	fn encode(data: &BTreeMap<String, Vec<String>>) -> Vec<u8> {
		serde_json::to_vec(data).unwrap_or_default()
	}

	fn decode(bytes: &[u8]) -> Option<BTreeMap<String, Vec<String>>> {
		if bytes.is_empty() {
			return None;
		}
		serde_json::from_slice(bytes).ok()
	}

	#[cfg(unix)]
	pub fn write_blob(path: &Path, data: &BTreeMap<String, Vec<String>>) {
		if data.is_empty() {
			if let Err(e) = xattr::remove(path, ATTR_NAME) {
				if e.kind() != std::io::ErrorKind::NotFound {
					tracing::debug!(
						"garnet_metadata mirror: remove({}) failed: {e}",
						path.display()
					);
				}
			}
			return;
		}
		let bytes = encode(data);
		if let Err(e) = xattr::set(path, ATTR_NAME, &bytes) {
			tracing::debug!(
				"garnet_metadata mirror: set({}) failed: {e}",
				path.display()
			);
		}
	}

	#[cfg(unix)]
	pub fn read_blob(path: &Path) -> Option<BTreeMap<String, Vec<String>>> {
		match xattr::get(path, ATTR_NAME) {
			Ok(Some(bytes)) => decode(&bytes),
			Ok(None) => None,
			Err(e) => {
				// `Unsupported` for FATs, network mounts, etc. is normal and
				// not worth a log line — only flag unexpected failures.
				if e.kind() != std::io::ErrorKind::Unsupported {
					tracing::debug!(
						"garnet_metadata mirror: get({}) failed: {e}",
						path.display()
					);
				}
				None
			}
		}
	}

	#[cfg(windows)]
	fn ads_path(path: &Path) -> std::ffi::OsString {
		// NTFS exposes alternate streams via the `path:streamname` syntax to
		// every standard CreateFile-based API, including std::fs.
		let mut p = path.as_os_str().to_os_string();
		p.push(":");
		p.push(ADS_NAME);
		p
	}

	#[cfg(windows)]
	pub fn write_blob(path: &Path, data: &BTreeMap<String, Vec<String>>) {
		use std::fs::OpenOptions;
		use std::io::Write;
		let stream = ads_path(path);
		if data.is_empty() {
			// Removing an ADS is best-effort: NTFS has no portable delete-
			// stream syscall in stable std. Overwrite with empty content so
			// the next read decodes to "no data".
			match OpenOptions::new()
				.write(true)
				.create(true)
				.truncate(true)
				.open(&stream)
			{
				Ok(_) => {}
				Err(e) => tracing::debug!(
					"garnet_metadata mirror: truncate ADS on {} failed: {e}",
					path.display()
				),
			}
			return;
		}
		let bytes = encode(data);
		match OpenOptions::new()
			.write(true)
			.create(true)
			.truncate(true)
			.open(&stream)
		{
			Ok(mut f) => {
				if let Err(e) = f.write_all(&bytes) {
					tracing::debug!(
						"garnet_metadata mirror: write ADS on {} failed: {e}",
						path.display()
					);
				}
			}
			Err(e) => tracing::debug!(
				"garnet_metadata mirror: open ADS on {} failed: {e}",
				path.display()
			),
		}
	}

	#[cfg(windows)]
	pub fn read_blob(path: &Path) -> Option<BTreeMap<String, Vec<String>>> {
		use std::fs::OpenOptions;
		use std::io::Read;
		let stream = ads_path(path);
		let mut f = OpenOptions::new().read(true).open(&stream).ok()?;
		let mut bytes = Vec::new();
		f.read_to_end(&mut bytes).ok()?;
		decode(&bytes)
	}
}

// ---- Tests -------------------------------------------------------------

#[cfg(test)]
mod tests {
	use super::*;
	use rusqlite::Connection;

	fn fresh_db() -> Connection {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
		)
		.unwrap();
		for &(v, sql) in crate::db::MIGRATIONS {
			let tx = conn.unchecked_transaction().unwrap();
			tx.execute_batch(sql).unwrap();
			tx.execute(
				"INSERT INTO migrations (version, applied_at) VALUES (?1, 0)",
				[v],
			)
			.unwrap();
			tx.commit().unwrap();
		}
		conn.execute_batch(
			"INSERT INTO library_roots (id, path, added_at) VALUES (1, '/tmp/r', 0);
			 INSERT INTO assets (id, root_id, relative_path) VALUES (1, 1, 'a.png');
			 INSERT INTO assets (id, root_id, relative_path) VALUES (2, 1, 'b.png');",
		)
		.unwrap();
		conn
	}

	#[test]
	fn add_remove_round_trip() {
		let conn = fresh_db();
		add_value(&conn, 1, "tags", "vacation").unwrap();
		add_value(&conn, 1, "tags", "2024").unwrap();
		add_value(&conn, 1, "rating", "5").unwrap();

		let entries = list_for_asset(&conn, 1).unwrap();
		assert_eq!(entries.len(), 2);
		// keys come back in NOCASE alpha order: rating, tags
		assert_eq!(entries[0].key, "rating");
		assert_eq!(entries[0].values, vec!["5"]);
		assert_eq!(entries[1].key, "tags");
		// Values within key follow insertion order via `position`.
		assert_eq!(entries[1].values, vec!["vacation", "2024"]);

		remove_value(&conn, 1, "tags", "vacation").unwrap();
		let entries = list_for_asset(&conn, 1).unwrap();
		assert_eq!(entries.iter().find(|e| e.key == "tags").unwrap().values, vec!["2024"]);

		remove_key(&conn, 1, "tags").unwrap();
		let entries = list_for_asset(&conn, 1).unwrap();
		assert!(entries.iter().all(|e| e.key != "tags"));
	}

	#[test]
	fn add_value_is_idempotent() {
		let conn = fresh_db();
		add_value(&conn, 1, "tags", "duplicate").unwrap();
		add_value(&conn, 1, "tags", "duplicate").unwrap();
		add_value(&conn, 1, "tags", "duplicate").unwrap();
		let entries = list_for_asset(&conn, 1).unwrap();
		assert_eq!(entries[0].values, vec!["duplicate"]);
	}

	#[test]
	fn set_key_replaces_existing() {
		let conn = fresh_db();
		add_value(&conn, 1, "tags", "old1").unwrap();
		add_value(&conn, 1, "tags", "old2").unwrap();
		set_key(&conn, 1, "tags", &["new".into()]).unwrap();
		let entries = list_for_asset(&conn, 1).unwrap();
		assert_eq!(entries[0].values, vec!["new"]);
	}

	#[test]
	fn distinct_values_with_counts() {
		let conn = fresh_db();
		add_value(&conn, 1, "tags", "shared").unwrap();
		add_value(&conn, 2, "tags", "shared").unwrap();
		add_value(&conn, 1, "tags", "only-on-1").unwrap();
		let counts = distinct_values_for_key(&conn, "tags").unwrap();
		let shared = counts.iter().find(|c| c.value == "shared").unwrap();
		let solo = counts.iter().find(|c| c.value == "only-on-1").unwrap();
		assert_eq!(shared.count, 2);
		assert_eq!(solo.count, 1);
	}

	#[test]
	fn empty_set_key_is_remove() {
		let conn = fresh_db();
		add_value(&conn, 1, "tags", "x").unwrap();
		set_key(&conn, 1, "tags", &[]).unwrap();
		let entries = list_for_asset(&conn, 1).unwrap();
		assert!(entries.is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn xattr_mirror_round_trip() {
		// Only meaningful on filesystems that support user xattrs (tmpfs on
		// many Linux distros doesn't by default — fall back to a no-op assert
		// rather than failing the test).
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("sample.txt");
		std::fs::write(&path, b"hello").unwrap();

		let mut data = BTreeMap::new();
		data.insert("tags".to_string(), vec!["a".to_string(), "b".to_string()]);
		mirror::write_blob(&path, &data);

		match mirror::read_blob(&path) {
			Some(read) => assert_eq!(read, data),
			None => {
				// xattrs unsupported on this temp filesystem — skip rather
				// than fail. We still exercised the encode path.
				eprintln!("skipping: xattrs unsupported on temp filesystem");
			}
		}
	}
}

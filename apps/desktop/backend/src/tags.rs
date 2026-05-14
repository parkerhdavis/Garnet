// SPDX-License-Identifier: AGPL-3.0-or-later
//! Tag CRUD and asset⇄tag association. Tags are flat for Phase 1 — the schema
//! reserves a `parent_id` column for a future hierarchy migration, but no
//! command set creates a tag with a parent yet.

use crate::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Tag {
	pub id: i64,
	pub name: String,
	pub parent_id: Option<i64>,
	pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TagWithCount {
	pub id: i64,
	pub name: String,
	pub count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetMetadata {
	pub key: String,
	pub value: String,
}

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<TagWithCount>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare(
			"SELECT t.id, t.name, COUNT(at.asset_id) AS c
			 FROM tags t
			 LEFT JOIN asset_tags at ON at.tag_id = t.id
			 GROUP BY t.id
			 ORDER BY t.name COLLATE NOCASE ASC",
		)
		.map_err(stringify)?;
	let rows = stmt
		.query_map([], |r| {
			Ok(TagWithCount {
				id: r.get(0)?,
				name: r.get(1)?,
				count: r.get(2)?,
			})
		})
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}

#[tauri::command]
pub fn create_tag(state: State<AppState>, name: String) -> Result<Tag, String> {
	let trimmed = name.trim().to_string();
	if trimmed.is_empty() {
		return Err("tag name cannot be empty".into());
	}
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute(
		"INSERT INTO tags (name, parent_id, created_at) VALUES (?1, NULL, strftime('%s','now'))
		 ON CONFLICT(name) DO NOTHING",
		[&trimmed],
	)
	.map_err(stringify)?;
	let row = conn
		.query_row(
			"SELECT id, name, parent_id, created_at FROM tags WHERE name = ?1 COLLATE NOCASE",
			[&trimmed],
			|r| {
				Ok(Tag {
					id: r.get(0)?,
					name: r.get(1)?,
					parent_id: r.get(2)?,
					created_at: r.get(3)?,
				})
			},
		)
		.map_err(stringify)?;
	Ok(row)
}

#[tauri::command]
pub fn delete_tag(state: State<AppState>, id: i64) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("DELETE FROM tags WHERE id = ?1", [id])
		.map_err(stringify)?;
	Ok(())
}

#[tauri::command]
pub fn tag_asset(state: State<AppState>, asset_id: i64, tag_id: i64) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute(
		"INSERT INTO asset_tags (asset_id, tag_id) VALUES (?1, ?2)
		 ON CONFLICT(asset_id, tag_id) DO NOTHING",
		params![asset_id, tag_id],
	)
	.map_err(stringify)?;
	Ok(())
}

#[tauri::command]
pub fn untag_asset(state: State<AppState>, asset_id: i64, tag_id: i64) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute(
		"DELETE FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
		params![asset_id, tag_id],
	)
	.map_err(stringify)?;
	Ok(())
}

#[tauri::command]
pub fn list_asset_tags(state: State<AppState>, asset_id: i64) -> Result<Vec<Tag>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare(
			"SELECT t.id, t.name, t.parent_id, t.created_at
			 FROM tags t
			 JOIN asset_tags at ON at.tag_id = t.id
			 WHERE at.asset_id = ?1
			 ORDER BY t.name COLLATE NOCASE",
		)
		.map_err(stringify)?;
	let rows = stmt
		.query_map([asset_id], |r| {
			Ok(Tag {
				id: r.get(0)?,
				name: r.get(1)?,
				parent_id: r.get(2)?,
				created_at: r.get(3)?,
			})
		})
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}

#[tauri::command]
pub fn list_asset_metadata(
	state: State<AppState>,
	asset_id: i64,
) -> Result<Vec<AssetMetadata>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare(
			"SELECT key, value FROM asset_metadata WHERE asset_id = ?1
			 ORDER BY key ASC",
		)
		.map_err(stringify)?;
	let rows = stmt
		.query_map([asset_id], |r| {
			Ok(AssetMetadata {
				key: r.get(0)?,
				value: r.get(1)?,
			})
		})
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}

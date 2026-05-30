// SPDX-License-Identifier: AGPL-3.0-or-later
//! User-created workspaces backing the sidebar's Workspaces section. A
//! workspace has a `type` that selects which interior renders it: the base
//! "library" type (a named, optionally-filtered library view) or a
//! plugin-contributed workflow type (e.g. "texturing"). `config` is an opaque
//! JSON blob owned by whatever renders the interior — the backend just stores
//! and returns it verbatim.

use crate::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Workspace {
	pub id: i64,
	pub name: String,
	/// Workspace type id. Named `kind` in Rust to avoid the `type` keyword;
	/// serialized as "type" to match the frontend shape.
	#[serde(rename = "type")]
	pub kind: String,
	pub icon: Option<String>,
	/// Opaque type-specific JSON. Stored as TEXT in the DB; surfaced as a
	/// parsed value to the frontend.
	pub config: Value,
	pub sort_order: i64,
	pub created_at: i64,
}

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

/// Parse the stored config TEXT into a JSON value, defaulting to `{}` if the
/// column is somehow not valid JSON (shouldn't happen — we only ever write
/// serialized JSON — but keeps a corrupt row from breaking the whole list).
fn parse_config(text: &str) -> Value {
	serde_json::from_str(text).unwrap_or_else(|_| Value::Object(Default::default()))
}

fn row_to_workspace(r: &rusqlite::Row) -> rusqlite::Result<Workspace> {
	let config_text: String = r.get(4)?;
	Ok(Workspace {
		id: r.get(0)?,
		name: r.get(1)?,
		kind: r.get(2)?,
		icon: r.get(3)?,
		config: parse_config(&config_text),
		sort_order: r.get(5)?,
		created_at: r.get(6)?,
	})
}

const SELECT_COLS: &str =
	"id, name, type, icon, config, sort_order, created_at FROM workspaces";

#[tauri::command]
pub fn list_workspaces(state: State<AppState>) -> Result<Vec<Workspace>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare(&format!("SELECT {SELECT_COLS} ORDER BY sort_order ASC, id ASC"))
		.map_err(stringify)?;
	let rows = stmt
		.query_map([], row_to_workspace)
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}

#[tauri::command]
pub fn create_workspace(
	state: State<AppState>,
	name: String,
	workspace_type: String,
	icon: Option<String>,
) -> Result<Workspace, String> {
	let name = name.trim().to_string();
	if name.is_empty() {
		return Err("Workspace name cannot be empty".into());
	}
	let conn = state.db.lock().map_err(stringify)?;
	// Append to the end of the current ordering.
	conn.execute(
		"INSERT INTO workspaces (name, type, icon, config, sort_order, created_at)
		 VALUES (
		     ?1, ?2, ?3, '{}',
		     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspaces),
		     strftime('%s','now')
		 )",
		params![name, workspace_type, icon],
	)
	.map_err(stringify)?;
	let id = conn.last_insert_rowid();
	let row = conn
		.query_row(
			&format!("SELECT {SELECT_COLS} WHERE id = ?1"),
			[id],
			row_to_workspace,
		)
		.map_err(stringify)?;
	tracing::info!("created workspace id={} type={}", row.id, row.kind);
	Ok(row)
}

#[tauri::command]
pub fn rename_workspace(state: State<AppState>, id: i64, name: String) -> Result<(), String> {
	let name = name.trim().to_string();
	if name.is_empty() {
		return Err("Workspace name cannot be empty".into());
	}
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("UPDATE workspaces SET name = ?2 WHERE id = ?1", params![id, name])
		.map_err(stringify)?;
	Ok(())
}

#[tauri::command]
pub fn update_workspace_config(
	state: State<AppState>,
	id: i64,
	config: Value,
) -> Result<(), String> {
	let text = serde_json::to_string(&config).map_err(stringify)?;
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("UPDATE workspaces SET config = ?2 WHERE id = ?1", params![id, text])
		.map_err(stringify)?;
	Ok(())
}

#[tauri::command]
pub fn delete_workspace(state: State<AppState>, id: i64) -> Result<(), String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.execute("DELETE FROM workspaces WHERE id = ?1", [id])
		.map_err(stringify)?;
	tracing::info!("deleted workspace id={id}");
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::db::MIGRATIONS;
	use rusqlite::Connection;

	fn fresh_db() -> Connection {
		let conn = Connection::open_in_memory().unwrap();
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

	#[test]
	fn create_lists_and_orders() {
		let conn = fresh_db();
		conn.execute(
			"INSERT INTO workspaces (name, type, config, sort_order, created_at)
			 VALUES ('A', 'library', '{}', 0, 0), ('B', 'texturing', '{}', 1, 0)",
			[],
		)
		.unwrap();
		let mut stmt = conn
			.prepare(&format!("SELECT {SELECT_COLS} ORDER BY sort_order ASC, id ASC"))
			.unwrap();
		let rows: Vec<Workspace> = stmt
			.query_map([], row_to_workspace)
			.unwrap()
			.collect::<Result<_, _>>()
			.unwrap();
		assert_eq!(rows.len(), 2);
		assert_eq!(rows[0].name, "A");
		assert_eq!(rows[1].kind, "texturing");
	}

	#[test]
	fn config_roundtrips_as_json() {
		let conn = fresh_db();
		let cfg = serde_json::json!({ "savedQuery": { "formats": ["png"] } });
		let text = serde_json::to_string(&cfg).unwrap();
		conn.execute(
			"INSERT INTO workspaces (name, type, config, sort_order, created_at)
			 VALUES ('W', 'library', ?1, 0, 0)",
			[text],
		)
		.unwrap();
		let row = conn
			.query_row(&format!("SELECT {SELECT_COLS} WHERE name = 'W'"), [], row_to_workspace)
			.unwrap();
		assert_eq!(row.config, cfg);
	}
}

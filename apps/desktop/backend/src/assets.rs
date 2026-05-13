// SPDX-License-Identifier: AGPL-3.0-or-later
//! Asset browsing queries against the local library DB. The browser is
//! deliberately the first user-visible payoff for the scanner: a paginated,
//! sortable, filterable table over the `assets` rows that the indexer
//! populates. Real previewing, tagging, and search facets land later — this is
//! the floor.

use crate::AppState;
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Asset {
	pub id: i64,
	pub root_id: i64,
	pub relative_path: String,
	pub size: Option<i64>,
	pub mtime: Option<i64>,
	pub format: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AssetSortBy {
	Path,
	Size,
	Mtime,
	Format,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
	Asc,
	Desc,
}

/// Whitelisted sort spec → SQL fragment. Keeping this a match arm rather than
/// a format!() guards against SQL injection through the sort parameters even
/// though they're coming from our own frontend.
fn order_clause(by: AssetSortBy, dir: SortDir) -> &'static str {
	match (by, dir) {
		(AssetSortBy::Path, SortDir::Asc) => "ORDER BY relative_path COLLATE NOCASE ASC",
		(AssetSortBy::Path, SortDir::Desc) => "ORDER BY relative_path COLLATE NOCASE DESC",
		(AssetSortBy::Size, SortDir::Asc) => "ORDER BY size ASC NULLS LAST",
		(AssetSortBy::Size, SortDir::Desc) => "ORDER BY size DESC NULLS LAST",
		(AssetSortBy::Mtime, SortDir::Asc) => "ORDER BY mtime ASC NULLS LAST",
		(AssetSortBy::Mtime, SortDir::Desc) => "ORDER BY mtime DESC NULLS LAST",
		(AssetSortBy::Format, SortDir::Asc) => {
			"ORDER BY format COLLATE NOCASE ASC NULLS LAST, relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Format, SortDir::Desc) => {
			"ORDER BY format COLLATE NOCASE DESC NULLS LAST, relative_path COLLATE NOCASE ASC"
		}
	}
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetQuery {
	pub root_id: i64,
	#[serde(default = "default_limit")]
	pub limit: i64,
	#[serde(default)]
	pub offset: i64,
	#[serde(default = "default_sort_by")]
	pub sort_by: AssetSortBy,
	#[serde(default = "default_sort_dir")]
	pub sort_dir: SortDir,
	#[serde(default)]
	pub format_filter: Option<String>,
}

fn default_limit() -> i64 {
	100
}
fn default_sort_by() -> AssetSortBy {
	AssetSortBy::Path
}
fn default_sort_dir() -> SortDir {
	SortDir::Asc
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetPage {
	pub assets: Vec<Asset>,
	pub total: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FormatCount {
	pub format: Option<String>,
	pub count: i64,
}

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

/// Build a `(where_sql, params)` pair from a query. `where_sql` always starts
/// with `WHERE root_id = ?` so callers can append more clauses or an
/// `ORDER BY` directly.
fn where_clause(q: &AssetQuery) -> (String, Vec<Box<dyn ToSql>>) {
	let mut sql = String::from("WHERE root_id = ?");
	let mut params: Vec<Box<dyn ToSql>> = vec![Box::new(q.root_id)];

	if let Some(filter) = &q.format_filter {
		if !filter.is_empty() {
			sql.push_str(" AND format = ?");
			params.push(Box::new(filter.to_ascii_lowercase()));
		}
	}
	(sql, params)
}

pub fn list_assets_impl(conn: &Connection, q: &AssetQuery) -> rusqlite::Result<AssetPage> {
	let (where_sql, where_params) = where_clause(q);
	let limit = q.limit.clamp(1, 5_000);
	let offset = q.offset.max(0);

	let total: i64 = {
		let total_sql = format!("SELECT COUNT(*) FROM assets {where_sql}");
		let mut stmt = conn.prepare(&total_sql)?;
		let params_ref: Vec<&dyn ToSql> = where_params.iter().map(|b| b.as_ref()).collect();
		stmt.query_row(params_ref.as_slice(), |r| r.get(0))?
	};

	let list_sql = format!(
		"SELECT id, root_id, relative_path, size, mtime, format
		 FROM assets {where_sql} {order} LIMIT ? OFFSET ?",
		order = order_clause(q.sort_by, q.sort_dir)
	);
	let mut stmt = conn.prepare(&list_sql)?;
	let mut params_ref: Vec<&dyn ToSql> = where_params.iter().map(|b| b.as_ref()).collect();
	params_ref.push(&limit);
	params_ref.push(&offset);

	let assets = stmt
		.query_map(params_ref.as_slice(), |r| {
			Ok(Asset {
				id: r.get(0)?,
				root_id: r.get(1)?,
				relative_path: r.get(2)?,
				size: r.get(3)?,
				mtime: r.get(4)?,
				format: r.get(5)?,
			})
		})?
		.collect::<rusqlite::Result<Vec<_>>>()?;

	Ok(AssetPage { assets, total })
}

pub fn list_asset_formats_impl(
	conn: &Connection,
	root_id: i64,
) -> rusqlite::Result<Vec<FormatCount>> {
	let mut stmt = conn.prepare(
		"SELECT format, COUNT(*) AS c
		 FROM assets
		 WHERE root_id = ?
		 GROUP BY format
		 ORDER BY c DESC, format COLLATE NOCASE ASC",
	)?;
	let rows = stmt
		.query_map([root_id], |r| {
			Ok(FormatCount {
				format: r.get(0)?,
				count: r.get(1)?,
			})
		})?
		.collect::<rusqlite::Result<Vec<_>>>()?;
	Ok(rows)
}

#[tauri::command]
pub fn list_assets(state: State<AppState>, query: AssetQuery) -> Result<AssetPage, String> {
	let conn = state.db.lock().map_err(stringify)?;
	list_assets_impl(&conn, &query).map_err(stringify)
}

#[tauri::command]
pub fn list_asset_formats(state: State<AppState>, root_id: i64) -> Result<Vec<FormatCount>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	list_asset_formats_impl(&conn, root_id).map_err(stringify)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Apply the same schema as `db::MIGRATIONS[0]` to an in-memory connection
	/// so tests don't depend on the on-disk DB. If the migration list grows,
	/// this helper should be updated to apply all migrations rather than
	/// duplicating SQL — for now there's only the v1 schema.
	fn fresh_db() -> Connection {
		let conn = Connection::open_in_memory().unwrap();
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
			INSERT INTO library_roots (id, path, added_at) VALUES (1, '/tmp/r1', 0);
			INSERT INTO library_roots (id, path, added_at) VALUES (2, '/tmp/r2', 0);
			INSERT INTO assets (root_id, relative_path, size, mtime, format) VALUES
				(1, 'a.png',           100, 10, 'png'),
				(1, 'b.jpg',           250, 20, 'jpg'),
				(1, 'sub/c.png',        50, 15, 'png'),
				(1, 'd.txt',          1000, 25, 'txt'),
				(1, 'NO_EXT',           42,  5, NULL),
				(2, 'other-root.png',   99,  9, 'png');
			",
		)
		.unwrap();
		conn
	}

	fn q(root_id: i64) -> AssetQuery {
		AssetQuery {
			root_id,
			limit: 100,
			offset: 0,
			sort_by: AssetSortBy::Path,
			sort_dir: SortDir::Asc,
			format_filter: None,
		}
	}

	#[test]
	fn lists_only_assets_for_given_root() {
		let conn = fresh_db();
		let page = list_assets_impl(&conn, &q(1)).unwrap();
		assert_eq!(page.total, 5);
		assert_eq!(page.assets.len(), 5);
		for a in &page.assets {
			assert_eq!(a.root_id, 1);
		}
	}

	#[test]
	fn sorts_by_size_desc() {
		let conn = fresh_db();
		let mut query = q(1);
		query.sort_by = AssetSortBy::Size;
		query.sort_dir = SortDir::Desc;
		let page = list_assets_impl(&conn, &query).unwrap();
		let sizes: Vec<_> = page.assets.iter().map(|a| a.size).collect();
		assert_eq!(sizes, vec![Some(1000), Some(250), Some(100), Some(50), Some(42)]);
	}

	#[test]
	fn paginates() {
		let conn = fresh_db();
		let mut query = q(1);
		query.limit = 2;
		query.offset = 0;
		let p1 = list_assets_impl(&conn, &query).unwrap();
		assert_eq!(p1.total, 5);
		assert_eq!(p1.assets.len(), 2);

		query.offset = 2;
		let p2 = list_assets_impl(&conn, &query).unwrap();
		assert_eq!(p2.assets.len(), 2);

		query.offset = 4;
		let p3 = list_assets_impl(&conn, &query).unwrap();
		assert_eq!(p3.assets.len(), 1);
	}

	#[test]
	fn filters_by_format() {
		let conn = fresh_db();
		let mut query = q(1);
		query.format_filter = Some("png".into());
		let page = list_assets_impl(&conn, &query).unwrap();
		assert_eq!(page.total, 2);
		assert!(page.assets.iter().all(|a| a.format.as_deref() == Some("png")));
	}

	#[test]
	fn format_filter_is_case_insensitive_on_input() {
		let conn = fresh_db();
		let mut query = q(1);
		query.format_filter = Some("PNG".into());
		let page = list_assets_impl(&conn, &query).unwrap();
		assert_eq!(page.total, 2);
	}

	#[test]
	fn lists_format_counts_for_root() {
		let conn = fresh_db();
		let formats = list_asset_formats_impl(&conn, 1).unwrap();
		// Most common (png=2) first; null entry still appears.
		let pngs = formats.iter().find(|f| f.format.as_deref() == Some("png")).unwrap();
		assert_eq!(pngs.count, 2);
		let jpgs = formats.iter().find(|f| f.format.as_deref() == Some("jpg")).unwrap();
		assert_eq!(jpgs.count, 1);
		let nulls = formats.iter().find(|f| f.format.is_none()).unwrap();
		assert_eq!(nulls.count, 1);
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Asset browsing queries against the local library DB. The browser is
//! deliberately the first user-visible payoff for the scanner: a paginated,
//! sortable, filterable view over the `assets` rows that the indexer
//! populates. Cross-root by default — pass `root_id` to scope to one root.

use crate::AppState;
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Asset {
	pub id: i64,
	pub root_id: i64,
	pub root_path: String,
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
	Root,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
	Asc,
	Desc,
}

/// Whitelisted sort spec → SQL fragment. Match-arm rather than format!() so
/// the sort parameters can never carry SQL injection even though they
/// originate in our own frontend.
fn order_clause(by: AssetSortBy, dir: SortDir) -> &'static str {
	match (by, dir) {
		(AssetSortBy::Path, SortDir::Asc) => "ORDER BY a.relative_path COLLATE NOCASE ASC",
		(AssetSortBy::Path, SortDir::Desc) => "ORDER BY a.relative_path COLLATE NOCASE DESC",
		(AssetSortBy::Size, SortDir::Asc) => "ORDER BY a.size ASC NULLS LAST",
		(AssetSortBy::Size, SortDir::Desc) => "ORDER BY a.size DESC NULLS LAST",
		(AssetSortBy::Mtime, SortDir::Asc) => "ORDER BY a.mtime ASC NULLS LAST",
		(AssetSortBy::Mtime, SortDir::Desc) => "ORDER BY a.mtime DESC NULLS LAST",
		(AssetSortBy::Format, SortDir::Asc) => {
			"ORDER BY a.format COLLATE NOCASE ASC NULLS LAST, a.relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Format, SortDir::Desc) => {
			"ORDER BY a.format COLLATE NOCASE DESC NULLS LAST, a.relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Root, SortDir::Asc) => {
			"ORDER BY r.path COLLATE NOCASE ASC, a.relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Root, SortDir::Desc) => {
			"ORDER BY r.path COLLATE NOCASE DESC, a.relative_path COLLATE NOCASE ASC"
		}
	}
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetQuery {
	#[serde(default)]
	pub root_id: Option<i64>,
	#[serde(default = "default_limit")]
	pub limit: i64,
	#[serde(default)]
	pub offset: i64,
	#[serde(default = "default_sort_by")]
	pub sort_by: AssetSortBy,
	#[serde(default = "default_sort_dir")]
	pub sort_dir: SortDir,
	/// Empty vec / absent → no format filter. Otherwise, asset's `format` must
	/// match one of the lowercased entries.
	#[serde(default)]
	pub formats: Vec<String>,
	/// Empty vec / absent → no exclusion. Otherwise, asset's `format` must
	/// be NULL or not in the lowercased entries. Used by the "Other" type
	/// view, which catches everything that isn't already categorized.
	#[serde(default)]
	pub formats_exclude: Vec<String>,
	#[serde(default)]
	pub path_search: Option<String>,
	#[serde(default)]
	pub size_min: Option<i64>,
	#[serde(default)]
	pub size_max: Option<i64>,
	#[serde(default)]
	pub mtime_from: Option<i64>,
	#[serde(default)]
	pub mtime_to: Option<i64>,
	/// Empty / absent → no tag filter. Otherwise, asset must be tagged with
	/// **all** listed tag ids (AND semantics).
	#[serde(default)]
	pub tag_ids: Vec<i64>,
	/// Scope to a pinned source: resolves to the pin's (root_id,
	/// relative_path_to_root) and limits the results accordingly. Honored
	/// alongside an explicit `root_id` (if both are set the explicit
	/// root_id must match the pin's root_id or the query returns nothing).
	#[serde(default)]
	pub pinned_source_id: Option<i64>,
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

/// Build a parameterized `WHERE ...` clause for the given query. Always starts
/// with `WHERE 1=1` so subsequent `AND` clauses compose cleanly regardless of
/// which filters are active. `pinned_prefix`, when present, scopes results to
/// the path `relative_path = ? OR relative_path LIKE ? || '/%'` — used after
/// resolving a `pinned_source_id` filter to its (root_id, relative) pair.
fn where_clause(
	q: &AssetQuery,
	pinned_prefix: Option<&str>,
) -> (String, Vec<Box<dyn ToSql>>) {
	let mut sql = String::from("WHERE 1=1");
	let mut params: Vec<Box<dyn ToSql>> = Vec::new();

	if let Some(root_id) = q.root_id {
		sql.push_str(" AND a.root_id = ?");
		params.push(Box::new(root_id));
	}

	if let Some(prefix) = pinned_prefix {
		sql.push_str(" AND (a.relative_path = ? OR a.relative_path LIKE ? || '/%')");
		params.push(Box::new(prefix.to_string()));
		params.push(Box::new(prefix.to_string()));
	}

	if !q.formats.is_empty() {
		let placeholders = vec!["?"; q.formats.len()].join(",");
		sql.push_str(&format!(" AND a.format IN ({placeholders})"));
		for f in &q.formats {
			params.push(Box::new(f.to_ascii_lowercase()));
		}
	}

	if !q.formats_exclude.is_empty() {
		// Include NULL-format assets in the "not in" set — they're the
		// extensionless files that belong to "Other" alongside any
		// unrecognized extensions.
		let placeholders = vec!["?"; q.formats_exclude.len()].join(",");
		sql.push_str(&format!(
			" AND (a.format IS NULL OR a.format NOT IN ({placeholders}))"
		));
		for f in &q.formats_exclude {
			params.push(Box::new(f.to_ascii_lowercase()));
		}
	}

	if let Some(search) = &q.path_search {
		let s = search.trim();
		if !s.is_empty() {
			sql.push_str(" AND a.relative_path LIKE ? COLLATE NOCASE");
			params.push(Box::new(format!("%{s}%")));
		}
	}

	if let Some(min) = q.size_min {
		sql.push_str(" AND a.size >= ?");
		params.push(Box::new(min));
	}
	if let Some(max) = q.size_max {
		sql.push_str(" AND a.size <= ?");
		params.push(Box::new(max));
	}
	if let Some(from) = q.mtime_from {
		sql.push_str(" AND a.mtime >= ?");
		params.push(Box::new(from));
	}
	if let Some(to) = q.mtime_to {
		sql.push_str(" AND a.mtime <= ?");
		params.push(Box::new(to));
	}

	// Tag filter — AND across tags (asset must carry every listed tag). Done
	// via `NOT EXISTS (... tag_id NOT IN (..) ...)` is fragile under
	// duplicates; cleanest is a HAVING clause counting matched tag rows.
	if !q.tag_ids.is_empty() {
		let placeholders = vec!["?"; q.tag_ids.len()].join(",");
		sql.push_str(&format!(
			" AND a.id IN (
				SELECT asset_id FROM asset_tags
				WHERE tag_id IN ({placeholders})
				GROUP BY asset_id
				HAVING COUNT(DISTINCT tag_id) = ?
			)"
		));
		for tid in &q.tag_ids {
			params.push(Box::new(*tid));
		}
		params.push(Box::new(q.tag_ids.len() as i64));
	}

	(sql, params)
}

pub fn list_assets_impl(conn: &Connection, q: &AssetQuery) -> rusqlite::Result<AssetPage> {
	// Resolve a pinned_source_id filter into root_id + relative-path-prefix
	// constraints before building the WHERE clause. Done here rather than in
	// where_clause() so the resolution can issue its own SQL query.
	let mut effective = q.clone();
	let mut pinned_prefix: Option<String> = None;
	if let Some(psid) = q.pinned_source_id {
		let (root_id, rel) = crate::pinned_sources::resolve_pinned_source(conn, psid)?;
		// If an explicit root_id was already set and conflicts, force-empty
		// the result rather than silently widening.
		if let Some(rid) = effective.root_id {
			if rid != root_id {
				tracing::warn!(
					"list_assets: root_id={} conflicts with pinned_source root_id={}",
					rid, root_id
				);
				return Ok(AssetPage { assets: Vec::new(), total: 0 });
			}
		}
		effective.root_id = Some(root_id);
		if !rel.is_empty() {
			pinned_prefix = Some(rel);
		}
	}

	let (where_sql, where_params) = where_clause(&effective, pinned_prefix.as_deref());
	let limit = effective.limit.clamp(1, 5_000);
	let offset = effective.offset.max(0);

	let total: i64 = {
		let total_sql = format!(
			"SELECT COUNT(*) FROM assets a JOIN library_roots r ON r.id = a.root_id {where_sql}"
		);
		let mut stmt = conn.prepare(&total_sql)?;
		let params_ref: Vec<&dyn ToSql> = where_params.iter().map(|b| b.as_ref()).collect();
		stmt.query_row(params_ref.as_slice(), |r| r.get(0))?
	};

	let list_sql = format!(
		"SELECT a.id, a.root_id, r.path, a.relative_path, a.size, a.mtime, a.format
		 FROM assets a JOIN library_roots r ON r.id = a.root_id
		 {where_sql} {order} LIMIT ? OFFSET ?",
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
				root_path: r.get(2)?,
				relative_path: r.get(3)?,
				size: r.get(4)?,
				mtime: r.get(5)?,
				format: r.get(6)?,
			})
		})?
		.collect::<rusqlite::Result<Vec<_>>>()?;

	Ok(AssetPage { assets, total })
}

pub fn list_asset_formats_impl(
	conn: &Connection,
	root_id: Option<i64>,
) -> rusqlite::Result<Vec<FormatCount>> {
	let (sql, params): (&str, Vec<Box<dyn ToSql>>) = match root_id {
		Some(id) => (
			"SELECT format, COUNT(*) AS c
			 FROM assets
			 WHERE root_id = ?
			 GROUP BY format
			 ORDER BY c DESC, format COLLATE NOCASE ASC",
			vec![Box::new(id)],
		),
		None => (
			"SELECT format, COUNT(*) AS c
			 FROM assets
			 GROUP BY format
			 ORDER BY c DESC, format COLLATE NOCASE ASC",
			Vec::new(),
		),
	};
	let mut stmt = conn.prepare(sql)?;
	let params_ref: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref()).collect();
	let rows = stmt
		.query_map(params_ref.as_slice(), |r| {
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
pub fn list_asset_formats(
	state: State<AppState>,
	root_id: Option<i64>,
) -> Result<Vec<FormatCount>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	list_asset_formats_impl(&conn, root_id).map_err(stringify)
}

#[tauri::command]
pub fn get_asset(state: State<AppState>, id: i64) -> Result<Asset, String> {
	let conn = state.db.lock().map_err(stringify)?;
	conn.query_row(
		"SELECT a.id, a.root_id, r.path, a.relative_path, a.size, a.mtime, a.format
		 FROM assets a JOIN library_roots r ON r.id = a.root_id
		 WHERE a.id = ?1",
		[id],
		|r| {
			Ok(Asset {
				id: r.get(0)?,
				root_id: r.get(1)?,
				root_path: r.get(2)?,
				relative_path: r.get(3)?,
				size: r.get(4)?,
				mtime: r.get(5)?,
				format: r.get(6)?,
			})
		},
	)
	.map_err(stringify)
}

#[cfg(test)]
mod tests {
	use super::*;

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
				(1, 'docs/d.txt',     1000, 25, 'txt'),
				(1, 'NO_EXT',           42,  5, NULL),
				(2, 'other-root.png',   99,  9, 'png');
			",
		)
		.unwrap();
		conn
	}

	fn default_query() -> AssetQuery {
		AssetQuery {
			root_id: None,
			limit: 100,
			offset: 0,
			sort_by: AssetSortBy::Path,
			sort_dir: SortDir::Asc,
			formats: Vec::new(),
			formats_exclude: Vec::new(),
			path_search: None,
			size_min: None,
			size_max: None,
			mtime_from: None,
			mtime_to: None,
			tag_ids: Vec::new(),
			pinned_source_id: None,
		}
	}

	fn fresh_db_with_tags() -> Connection {
		let conn = fresh_db();
		conn.execute_batch(
			"
			CREATE TABLE tags (
				id        INTEGER PRIMARY KEY,
				name      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
				parent_id INTEGER,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE asset_tags (
				asset_id INTEGER NOT NULL,
				tag_id   INTEGER NOT NULL,
				PRIMARY KEY (asset_id, tag_id)
			);
			INSERT INTO tags (id, name, parent_id, created_at) VALUES
				(1, 'red',    NULL, 0),
				(2, 'square', NULL, 0);
			INSERT INTO asset_tags VALUES
				(1, 1), (1, 2), -- a.png: red + square
				(2, 1),         -- b.jpg: red
				(3, 2);         -- sub/c.png: square
			",
		)
		.unwrap();
		conn
	}

	#[test]
	fn tag_filter_single() {
		let conn = fresh_db_with_tags();
		let mut q = default_query();
		q.tag_ids = vec![1]; // red
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 2);
	}

	#[test]
	fn tag_filter_and() {
		let conn = fresh_db_with_tags();
		let mut q = default_query();
		q.tag_ids = vec![1, 2]; // red AND square → only asset id 1
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 1);
		assert_eq!(page.assets[0].id, 1);
	}

	#[test]
	fn cross_root_default() {
		let conn = fresh_db();
		let page = list_assets_impl(&conn, &default_query()).unwrap();
		assert_eq!(page.total, 6);
		assert!(page.assets.iter().any(|a| a.root_id == 1));
		assert!(page.assets.iter().any(|a| a.root_id == 2));
	}

	#[test]
	fn scopes_to_root() {
		let conn = fresh_db();
		let mut q = default_query();
		q.root_id = Some(1);
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 5);
		assert!(page.assets.iter().all(|a| a.root_id == 1));
	}

	#[test]
	fn returns_root_path() {
		let conn = fresh_db();
		let mut q = default_query();
		q.root_id = Some(2);
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.assets.len(), 1);
		assert_eq!(page.assets[0].root_path, "/tmp/r2");
	}

	#[test]
	fn sorts_by_size_desc() {
		let conn = fresh_db();
		let mut q = default_query();
		q.sort_by = AssetSortBy::Size;
		q.sort_dir = SortDir::Desc;
		let page = list_assets_impl(&conn, &q).unwrap();
		let sizes: Vec<_> = page.assets.iter().map(|a| a.size).collect();
		assert_eq!(sizes[0], Some(1000));
		assert_eq!(sizes[1], Some(250));
	}

	#[test]
	fn paginates() {
		let conn = fresh_db();
		let mut q = default_query();
		q.limit = 2;
		q.offset = 0;
		let p1 = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(p1.total, 6);
		assert_eq!(p1.assets.len(), 2);

		q.offset = 4;
		let p3 = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(p3.assets.len(), 2);
	}

	#[test]
	fn multi_format_filter() {
		let conn = fresh_db();
		let mut q = default_query();
		q.formats = vec!["png".into(), "jpg".into()];
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 4);
		assert!(page
			.assets
			.iter()
			.all(|a| a.format.as_deref() == Some("png") || a.format.as_deref() == Some("jpg")));
	}

	#[test]
	fn format_exclude_filter_includes_null_format() {
		// "Other" semantics: everything not in the categorized set, plus
		// assets with no extension (format IS NULL). The fixture has png/jpg/
		// txt/NULL across six rows; excluding png+jpg should yield txt + NULL.
		let conn = fresh_db();
		let mut q = default_query();
		q.formats_exclude = vec!["png".into(), "jpg".into()];
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 2);
		let formats: Vec<_> = page.assets.iter().map(|a| a.format.clone()).collect();
		assert!(formats.contains(&Some("txt".into())));
		assert!(formats.contains(&None));
	}

	#[test]
	fn format_exclude_is_case_insensitive() {
		let conn = fresh_db();
		let mut q = default_query();
		q.formats_exclude = vec!["PNG".into(), "JPG".into(), "TXT".into()];
		let page = list_assets_impl(&conn, &q).unwrap();
		// Only the NULL-format row should remain.
		assert_eq!(page.total, 1);
		assert!(page.assets[0].format.is_none());
	}

	#[test]
	fn format_filter_case_insensitive() {
		let conn = fresh_db();
		let mut q = default_query();
		q.formats = vec!["PNG".into()];
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 3);
	}

	#[test]
	fn path_search_substring() {
		let conn = fresh_db();
		let mut q = default_query();
		q.path_search = Some("sub".into());
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 1);
		assert!(page.assets[0].relative_path.contains("sub"));
	}

	#[test]
	fn path_search_case_insensitive() {
		let conn = fresh_db();
		let mut q = default_query();
		q.path_search = Some("DOCS".into());
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 1);
	}

	#[test]
	fn size_range() {
		let conn = fresh_db();
		let mut q = default_query();
		q.size_min = Some(100);
		q.size_max = Some(300);
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 2);
		for a in &page.assets {
			let s = a.size.unwrap();
			assert!((100..=300).contains(&s));
		}
	}

	#[test]
	fn mtime_range() {
		let conn = fresh_db();
		let mut q = default_query();
		q.mtime_from = Some(10);
		q.mtime_to = Some(20);
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 3);
	}

	#[test]
	fn list_formats_cross_root() {
		let conn = fresh_db();
		let all = list_asset_formats_impl(&conn, None).unwrap();
		let png = all.iter().find(|f| f.format.as_deref() == Some("png")).unwrap();
		assert_eq!(png.count, 3);
		let scoped = list_asset_formats_impl(&conn, Some(2)).unwrap();
		let png_scoped = scoped.iter().find(|f| f.format.as_deref() == Some("png")).unwrap();
		assert_eq!(png_scoped.count, 1);
	}

	#[test]
	fn sort_by_root() {
		let conn = fresh_db();
		let mut q = default_query();
		q.sort_by = AssetSortBy::Root;
		q.sort_dir = SortDir::Desc;
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.assets[0].root_path, "/tmp/r2");
	}

	fn fresh_db_with_pins() -> Connection {
		let conn = fresh_db();
		conn.execute_batch(
			"
			CREATE TABLE pinned_sources (
				id                    INTEGER PRIMARY KEY,
				root_id               INTEGER NOT NULL,
				relative_path_to_root TEXT    NOT NULL,
				name                  TEXT    NOT NULL,
				added_at              INTEGER NOT NULL,
				UNIQUE (root_id, relative_path_to_root)
			);
			-- pin id=1 → all of root 1
			-- pin id=2 → root 1, subfolder 'sub'
			-- pin id=3 → root 1, subfolder 'docs'
			INSERT INTO pinned_sources (id, root_id, relative_path_to_root, name, added_at)
			VALUES
				(1, 1, '',     'r1 root', 0),
				(2, 1, 'sub',  'sub',     0),
				(3, 1, 'docs', 'docs',    0);
			",
		)
		.unwrap();
		conn
	}

	#[test]
	fn pinned_source_root_level_returns_all_assets_in_that_root() {
		let conn = fresh_db_with_pins();
		let mut q = default_query();
		q.pinned_source_id = Some(1);
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 5);
		assert!(page.assets.iter().all(|a| a.root_id == 1));
	}

	#[test]
	fn pinned_source_subfolder_filters_by_path_prefix() {
		let conn = fresh_db_with_pins();
		let mut q = default_query();
		q.pinned_source_id = Some(2); // pin → 'sub'
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 1);
		assert!(page.assets[0].relative_path.starts_with("sub"));
	}

	#[test]
	fn pinned_source_returns_empty_when_explicit_root_id_conflicts() {
		let conn = fresh_db_with_pins();
		let mut q = default_query();
		q.pinned_source_id = Some(1); // pin → root_id=1
		q.root_id = Some(2);          // caller asked for root_id=2
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 0);
		assert!(page.assets.is_empty());
	}
}

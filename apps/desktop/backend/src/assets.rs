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
	/// True for 3D files that have a skeleton + animation curves but no
	/// mesh geometry (e.g. Mixamo retargeting clips). Detected by the
	/// frontend thumbnailer and persisted via `save_model_thumbnail`.
	/// NULL when classification hasn't run yet for this asset.
	#[serde(default)]
	pub is_motion_only: Option<bool>,
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

/// Whitelisted sort spec → SQL fragment (column expression with direction, no
/// leading "ORDER BY"). Match-arm rather than format!() so the sort parameters
/// can never carry SQL injection even though they originate in our own frontend.
fn sort_expr(by: AssetSortBy, dir: SortDir) -> &'static str {
	match (by, dir) {
		(AssetSortBy::Path, SortDir::Asc) => "a.relative_path COLLATE NOCASE ASC",
		(AssetSortBy::Path, SortDir::Desc) => "a.relative_path COLLATE NOCASE DESC",
		(AssetSortBy::Size, SortDir::Asc) => "a.size ASC NULLS LAST",
		(AssetSortBy::Size, SortDir::Desc) => "a.size DESC NULLS LAST",
		(AssetSortBy::Mtime, SortDir::Asc) => "a.mtime ASC NULLS LAST",
		(AssetSortBy::Mtime, SortDir::Desc) => "a.mtime DESC NULLS LAST",
		(AssetSortBy::Format, SortDir::Asc) => {
			"a.format COLLATE NOCASE ASC NULLS LAST, a.relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Format, SortDir::Desc) => {
			"a.format COLLATE NOCASE DESC NULLS LAST, a.relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Root, SortDir::Asc) => {
			"r.path COLLATE NOCASE ASC, a.relative_path COLLATE NOCASE ASC"
		}
		(AssetSortBy::Root, SortDir::Desc) => {
			"r.path COLLATE NOCASE DESC, a.relative_path COLLATE NOCASE ASC"
		}
	}
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetGroupBy {
	None,
	Root,
	Folder,
	Format,
	MtimeBucket,
}

fn default_group_by() -> AssetGroupBy {
	AssetGroupBy::None
}

/// Build the group-key fragment used as the *primary* ORDER BY when grouping is
/// active. Returns the SQL expression (with direction baked in) plus any bound
/// parameters that fragment introduces. None when group_by = None.
///
/// Folder grouping uses an `rtrim` + `replace` trick — `rtrim(path, chars)`
/// strips trailing characters that are in `chars`. By passing every non-slash
/// character (via `replace(path, '/', '')`) as the trim set, we strip back to
/// the last `/`, leaving the directory portion of the path. Works in pure SQL,
/// no UDF required.
///
/// Mtime-bucket grouping classifies into Today / Week / Month / Older /
/// Unknown by comparing against bound timestamps captured at query time.
fn group_expr(by: AssetGroupBy, dir: SortDir) -> Option<(String, Vec<Box<dyn ToSql>>)> {
	let dir_s = match dir {
		SortDir::Asc => "ASC",
		SortDir::Desc => "DESC",
	};
	match by {
		AssetGroupBy::None => None,
		AssetGroupBy::Root => Some((format!("r.path COLLATE NOCASE {dir_s}"), vec![])),
		AssetGroupBy::Folder => Some((
			format!(
				"rtrim(a.relative_path, replace(a.relative_path, '/', '')) COLLATE NOCASE {dir_s}"
			),
			vec![],
		)),
		AssetGroupBy::Format => Some((
			format!("a.format COLLATE NOCASE {dir_s} NULLS LAST"),
			vec![],
		)),
		AssetGroupBy::MtimeBucket => {
			let now = std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap_or_default()
				.as_secs() as i64;
			let day = 86_400_i64;
			let today = now - day;
			let week = now - 7 * day;
			let month = now - 30 * day;
			let expr = format!(
				"CASE \
					WHEN a.mtime IS NULL THEN 4 \
					WHEN a.mtime >= ? THEN 0 \
					WHEN a.mtime >= ? THEN 1 \
					WHEN a.mtime >= ? THEN 2 \
					ELSE 3 \
				 END {dir_s}"
			);
			Some((
				expr,
				vec![Box::new(today), Box::new(week), Box::new(month)],
			))
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
	#[serde(default = "default_group_by")]
	pub group_by: AssetGroupBy,
	#[serde(default = "default_sort_dir")]
	pub group_dir: SortDir,
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
	/// Empty / absent → no tag filter. Otherwise, asset must carry **every**
	/// listed tag (AND semantics) — tags are values of the `tags` key in the
	/// garnet_metadata table.
	#[serde(default)]
	pub tag_names: Vec<String>,
	/// Scope to a pinned source: resolves to the pin's (root_id,
	/// relative_path_to_root) and limits the results accordingly. Honored
	/// alongside an explicit `root_id` (if both are set the explicit
	/// root_id must match the pin's root_id or the query returns nothing).
	#[serde(default)]
	pub pinned_source_id: Option<i64>,
	/// When true, AND filter out assets with is_motion_only = 1. Used by
	/// the Models type view to exclude mesh-less motion files that
	/// belong under Animations instead.
	#[serde(default)]
	pub exclude_motion_only: bool,
	/// When non-empty, OR additionally include assets whose format is in
	/// this list AND is_motion_only = 1. Used by the Animations type
	/// view to pick up motion-only model files that wouldn't match the
	/// vanilla animation-format set.
	#[serde(default)]
	pub motion_only_overlay: Vec<String>,
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

	// Combined format filter: `formats` is the base allow-list; if
	// `motion_only_overlay` is also non-empty we OR-in a clause for
	// motion-only assets whose format is in the overlay list. Used by the
	// Animations type view to pull motion-only models in alongside the
	// vanilla animation formats.
	if !q.formats.is_empty() || !q.motion_only_overlay.is_empty() {
		let mut parts: Vec<String> = Vec::new();
		if !q.formats.is_empty() {
			let placeholders = vec!["?"; q.formats.len()].join(",");
			parts.push(format!("a.format IN ({placeholders})"));
			for f in &q.formats {
				params.push(Box::new(f.to_ascii_lowercase()));
			}
		}
		if !q.motion_only_overlay.is_empty() {
			let placeholders = vec!["?"; q.motion_only_overlay.len()].join(",");
			parts.push(format!(
				"(a.format IN ({placeholders}) AND a.is_motion_only = 1)"
			));
			for f in &q.motion_only_overlay {
				params.push(Box::new(f.to_ascii_lowercase()));
			}
		}
		sql.push_str(&format!(" AND ({})", parts.join(" OR ")));
	}

	if q.exclude_motion_only {
		sql.push_str(" AND (a.is_motion_only IS NULL OR a.is_motion_only = 0)");
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

	// Tag filter — AND across tags (asset must carry every listed tag). Tags
	// live in `garnet_metadata` under the well-known key `tags`. HAVING
	// counts distinct matches so duplicate rows can't satisfy the predicate.
	if !q.tag_names.is_empty() {
		let placeholders = vec!["?"; q.tag_names.len()].join(",");
		sql.push_str(&format!(
			" AND a.id IN (
				SELECT asset_id FROM garnet_metadata
				WHERE key = 'tags' AND value IN ({placeholders})
				GROUP BY asset_id
				HAVING COUNT(DISTINCT value) = ?
			)"
		));
		for name in &q.tag_names {
			params.push(Box::new(name.clone()));
		}
		params.push(Box::new(q.tag_names.len() as i64));
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

	let group = group_expr(q.group_by, q.group_dir);
	let order = match &group {
		Some((g, _)) => format!("ORDER BY {}, {}", g, sort_expr(q.sort_by, q.sort_dir)),
		None => format!("ORDER BY {}", sort_expr(q.sort_by, q.sort_dir)),
	};
	let list_sql = format!(
		"SELECT a.id, a.root_id, r.path, a.relative_path, a.size, a.mtime, a.format, a.is_motion_only
		 FROM assets a JOIN library_roots r ON r.id = a.root_id
		 {where_sql} {order} LIMIT ? OFFSET ?"
	);
	let mut stmt = conn.prepare(&list_sql)?;
	let mut params_ref: Vec<&dyn ToSql> = where_params.iter().map(|b| b.as_ref()).collect();
	if let Some((_, group_params)) = &group {
		for p in group_params {
			params_ref.push(p.as_ref());
		}
	}
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
				is_motion_only: r
					.get::<_, Option<i64>>(7)?
					.map(|v| v != 0),
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
		"SELECT a.id, a.root_id, r.path, a.relative_path, a.size, a.mtime, a.format, a.is_motion_only
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
				is_motion_only: r
					.get::<_, Option<i64>>(7)?
					.map(|v| v != 0),
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
				id             INTEGER PRIMARY KEY,
				root_id        INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
				relative_path  TEXT    NOT NULL,
				size           INTEGER,
				mtime          INTEGER,
				format         TEXT,
				is_motion_only INTEGER,
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
			group_by: AssetGroupBy::None,
			group_dir: SortDir::Asc,
			formats: Vec::new(),
			formats_exclude: Vec::new(),
			path_search: None,
			size_min: None,
			size_max: None,
			mtime_from: None,
			mtime_to: None,
			tag_names: Vec::new(),
			pinned_source_id: None,
			exclude_motion_only: false,
			motion_only_overlay: Vec::new(),
		}
	}

	fn fresh_db_with_tags() -> Connection {
		let conn = fresh_db();
		conn.execute_batch(
			"
			CREATE TABLE garnet_metadata (
				id         INTEGER PRIMARY KEY,
				asset_id   INTEGER NOT NULL,
				key        TEXT    NOT NULL,
				value      TEXT    NOT NULL,
				position   INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(asset_id, key, value)
			);
			INSERT INTO garnet_metadata (asset_id, key, value, position, created_at, updated_at) VALUES
				(1, 'tags', 'red',    0, 0, 0),   -- a.png: red + square
				(1, 'tags', 'square', 1, 0, 0),
				(2, 'tags', 'red',    0, 0, 0),   -- b.jpg: red
				(3, 'tags', 'square', 0, 0, 0);   -- sub/c.png: square
			",
		)
		.unwrap();
		conn
	}

	#[test]
	fn tag_filter_single() {
		let conn = fresh_db_with_tags();
		let mut q = default_query();
		q.tag_names = vec!["red".into()];
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.total, 2);
	}

	#[test]
	fn tag_filter_and() {
		let conn = fresh_db_with_tags();
		let mut q = default_query();
		q.tag_names = vec!["red".into(), "square".into()]; // → only asset id 1
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

	fn folder_of(rel: &str) -> &str {
		match rel.rfind('/') {
			Some(i) => &rel[..i],
			None => "",
		}
	}

	#[test]
	fn group_by_root_keeps_roots_contiguous() {
		let conn = fresh_db();
		let mut q = default_query();
		q.group_by = AssetGroupBy::Root;
		let page = list_assets_impl(&conn, &q).unwrap();
		// Each root's assets should appear in a single contiguous run.
		let mut seen: Vec<i64> = Vec::new();
		for a in &page.assets {
			if seen.last() != Some(&a.root_id) {
				assert!(
					!seen.contains(&a.root_id),
					"root {} reappeared after gap; ordering not contiguous",
					a.root_id
				);
				seen.push(a.root_id);
			}
		}
	}

	#[test]
	fn group_by_folder_keeps_folders_contiguous() {
		let conn = fresh_db();
		let mut q = default_query();
		q.group_by = AssetGroupBy::Folder;
		let page = list_assets_impl(&conn, &q).unwrap();
		let mut seen: Vec<String> = Vec::new();
		for a in &page.assets {
			let f = folder_of(&a.relative_path).to_string();
			if seen.last() != Some(&f) {
				assert!(!seen.contains(&f), "folder {f:?} reappeared after gap");
				seen.push(f);
			}
		}
	}

	#[test]
	fn group_by_format_keeps_formats_contiguous() {
		let conn = fresh_db();
		let mut q = default_query();
		q.group_by = AssetGroupBy::Format;
		let page = list_assets_impl(&conn, &q).unwrap();
		let mut seen: Vec<Option<String>> = Vec::new();
		for a in &page.assets {
			let f = a.format.clone();
			if seen.last() != Some(&f) {
				assert!(!seen.contains(&f), "format {f:?} reappeared after gap");
				seen.push(f);
			}
		}
	}

	#[test]
	fn group_by_applies_secondary_sort_within_group() {
		// Grouping by format with secondary sort by size DESC: within each
		// format the largest asset should come first.
		let conn = fresh_db();
		let mut q = default_query();
		q.group_by = AssetGroupBy::Format;
		q.group_dir = SortDir::Asc;
		q.sort_by = AssetSortBy::Size;
		q.sort_dir = SortDir::Desc;
		let page = list_assets_impl(&conn, &q).unwrap();
		// Walk: for each contiguous format run, sizes must be monotonically
		// non-increasing.
		let mut current_format: Option<Option<String>> = None;
		let mut last_size: Option<i64> = None;
		for a in &page.assets {
			if current_format.as_ref() != Some(&a.format) {
				current_format = Some(a.format.clone());
				last_size = a.size;
				continue;
			}
			if let (Some(prev), Some(cur)) = (last_size, a.size) {
				assert!(cur <= prev, "size not desc within format group");
			}
			last_size = a.size;
		}
	}

	#[test]
	fn group_by_mtime_bucket_runs() {
		// Mtime-bucket grouping uses bound timestamps relative to NOW. The
		// fixture mtimes (5..25) are all well in the past, so every row lands
		// in the "older" bucket. The query still has to execute cleanly with
		// the CASE expression and its bound parameters in the right order.
		let conn = fresh_db();
		let mut q = default_query();
		q.group_by = AssetGroupBy::MtimeBucket;
		let page = list_assets_impl(&conn, &q).unwrap();
		assert_eq!(page.assets.len() as i64, page.total);
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

// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLite library database. Schema is versioned via a `migrations` table; each
//! migration is an embedded SQL string applied in order. Add new entries to
//! `MIGRATIONS` at the bottom of the file — never edit an applied migration.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::PathBuf;

const APP_DIR_NAME: &str = "garnet";
const DB_FILE_NAME: &str = "library.sqlite";

pub fn db_path() -> Result<PathBuf> {
	let base = dirs::data_dir().context("could not determine OS data directory")?;
	let dir = base.join(APP_DIR_NAME);
	std::fs::create_dir_all(&dir).with_context(|| format!("creating {dir:?}"))?;
	Ok(dir.join(DB_FILE_NAME))
}

pub fn open_and_migrate() -> Result<Connection> {
	let path = db_path()?;
	tracing::info!("opening library db at {path:?}");
	let conn = Connection::open(&path).with_context(|| format!("opening {path:?}"))?;
	conn.execute_batch(
		"PRAGMA foreign_keys = ON;
		 PRAGMA journal_mode = WAL;
		 PRAGMA busy_timeout = 5000;",
	)?;
	apply_migrations(&conn)?;
	Ok(conn)
}

fn apply_migrations(conn: &Connection) -> Result<()> {
	conn.execute_batch(
		"CREATE TABLE IF NOT EXISTS migrations (
			version    INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)",
	)?;
	let applied: std::collections::HashSet<i64> = conn
		.prepare("SELECT version FROM migrations")?
		.query_map([], |r| r.get::<_, i64>(0))?
		.collect::<Result<_, _>>()?;

	for (version, sql) in MIGRATIONS {
		if applied.contains(version) {
			continue;
		}
		tracing::info!("applying migration {version}");
		let tx = conn.unchecked_transaction()?;
		tx.execute_batch(sql)?;
		tx.execute(
			"INSERT INTO migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
			[version],
		)?;
		tx.commit()?;
	}
	Ok(())
}

/// Ordered list of migrations. Each entry is `(version, sql)`. Versions must be
/// strictly increasing; never edit or remove an entry once it has shipped.
pub static MIGRATIONS: &[(i64, &str)] = &[
	(
		1,
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

		CREATE INDEX assets_by_root ON assets(root_id);
		CREATE INDEX assets_by_format ON assets(format);
		",
	),
	(
		2,
		"
		-- Content hashing for rename/deletion detection. Populated by the indexer
		-- lazily: a row's content_hash is filled when (size, mtime) changes or
		-- when the row is newly inserted. Nullable so existing rows don't all
		-- need to be re-hashed up front.
		ALTER TABLE assets ADD COLUMN content_hash TEXT;
		CREATE INDEX assets_by_hash ON assets(content_hash) WHERE content_hash IS NOT NULL;

		-- Flexible per-asset key/value store. Format-specific metadata (image
		-- dimensions, EXIF date/camera, ID3 title, etc.) lives here so adding a
		-- new format extractor doesn't require schema changes. Repeat keys
		-- allowed for multi-valued metadata (e.g., multiple genre tags).
		CREATE TABLE asset_metadata (
			id       INTEGER PRIMARY KEY,
			asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
			key      TEXT    NOT NULL,
			value    TEXT    NOT NULL
		);
		CREATE INDEX asset_metadata_by_asset ON asset_metadata(asset_id);
		CREATE INDEX asset_metadata_by_key   ON asset_metadata(key);

		-- Tags: flat for V1 (parent_id reserved for a future hierarchy migration).
		CREATE TABLE tags (
			id        INTEGER PRIMARY KEY,
			name      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
			parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE asset_tags (
			asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
			tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
			PRIMARY KEY (asset_id, tag_id)
		);
		CREATE INDEX asset_tags_by_tag ON asset_tags(tag_id);

		-- Collections: manual for V1 (smart collections will store a query JSON
		-- in `query_json` when added in a future migration; left null for now).
		CREATE TABLE collections (
			id         INTEGER PRIMARY KEY,
			name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
			kind       TEXT    NOT NULL DEFAULT 'manual',
			query_json TEXT,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE collection_assets (
			collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			asset_id      INTEGER NOT NULL REFERENCES assets(id)      ON DELETE CASCADE,
			added_at      INTEGER NOT NULL,
			PRIMARY KEY (collection_id, asset_id)
		);
		CREATE INDEX collection_assets_by_asset ON collection_assets(asset_id);
		",
	),
	(
		3,
		"
		-- Sidebar pinned sources. A pin can target either a whole library
		-- root or a sub-folder under one. relative_path_to_root is '' for
		-- root-level pins, otherwise the path under the root (no leading
		-- slash, no trailing slash). CASCADE on the root means removing a
		-- library root drops its pins too.
		CREATE TABLE pinned_sources (
			id                    INTEGER PRIMARY KEY,
			root_id               INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
			relative_path_to_root TEXT    NOT NULL,
			name                  TEXT    NOT NULL,
			added_at              INTEGER NOT NULL,
			UNIQUE (root_id, relative_path_to_root)
		);
		CREATE INDEX pinned_sources_by_root ON pinned_sources(root_id);
		",
	),
	(
		4,
		"
		-- User-editable metadata, distinct from `asset_metadata` (which holds
		-- format-extracted 'native' metadata produced by the indexer). One row
		-- per (asset, key, value); a key with multiple values produces multiple
		-- rows. `tags` is just a well-known key here — drop the dedicated tag
		-- tables in favor of this single store.
		CREATE TABLE garnet_metadata (
			id         INTEGER PRIMARY KEY,
			asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
			key        TEXT    NOT NULL,
			value      TEXT    NOT NULL,
			position   INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(asset_id, key, value)
		);
		CREATE INDEX garnet_metadata_by_asset_key ON garnet_metadata(asset_id, key);
		CREATE INDEX garnet_metadata_by_key_value ON garnet_metadata(key, value);

		-- Backfill existing tag relationships into garnet_metadata under the
		-- well-known 'tags' key, preserving each tag's existing created_at.
		INSERT OR IGNORE INTO garnet_metadata
			(asset_id, key, value, position, created_at, updated_at)
		SELECT at.asset_id, 'tags', t.name, 0, t.created_at, t.created_at
		FROM asset_tags at
		JOIN tags t ON t.id = at.tag_id;

		-- The dedicated tag tables are now redundant.
		DROP TABLE asset_tags;
		DROP TABLE tags;
		",
	),
	(
		5,
		"
		-- Motion-only flag for 3D assets that have a skeleton + animation
		-- curves but no actual mesh geometry (Mixamo retargeting clips,
		-- etc.). NULL = unknown (assume mesh-bearing); 1 = motion-only.
		-- Set by the frontend's modelThumbnailer when it detects 'bones
		-- but no mesh' on render, via save_model_thumbnail's motion_only
		-- parameter. typeFilters uses this to route motion-only files to
		-- the Animations bucket instead of Models.
		ALTER TABLE assets ADD COLUMN is_motion_only INTEGER;
		CREATE INDEX assets_by_motion_only
		    ON assets(is_motion_only) WHERE is_motion_only IS NOT NULL;
		",
	),
	(
		6,
		"
		-- Does this 3D asset contain a *meaningful* animation clip — one
		-- with >0.1 s duration and at least one track with more than one
		-- keyframe (see isMeaningfulClip in ModelPreview.tsx). Set by the
		-- frontend's modelThumbnailer on render. NULL = unknown (treated
		-- as 'no' by AssetThumbnail for the hover-preview decision so we
		-- don't spin up a WebGL context for what's probably a static
		-- model); the flag is filled in on the next thumbnail render for
		-- that asset, which the detail page force-triggers on visit.
		ALTER TABLE assets ADD COLUMN has_animation INTEGER;
		CREATE INDEX assets_by_has_animation
		    ON assets(has_animation) WHERE has_animation IS NOT NULL;
		",
	),
];

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn migrations_apply_idempotently() {
		let conn = Connection::open_in_memory().unwrap();
		apply_migrations(&conn).unwrap();
		// Re-applying is a no-op.
		apply_migrations(&conn).unwrap();
		let count: i64 = conn
			.query_row("SELECT COUNT(*) FROM migrations", [], |r| r.get(0))
			.unwrap();
		assert_eq!(count as usize, MIGRATIONS.len());
	}

	#[test]
	fn tag_backfill_into_garnet_metadata() {
		// Apply migrations 1..=3 manually, seed legacy tag data, then run the
		// remaining migrations and check that tags now live in garnet_metadata.
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
		)
		.unwrap();
		for &(v, sql) in MIGRATIONS.iter().take(3) {
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
			"INSERT INTO library_roots (id, path, added_at) VALUES (1, '/tmp/r1', 0);
			 INSERT INTO assets (id, root_id, relative_path) VALUES (1, 1, 'a.png');
			 INSERT INTO assets (id, root_id, relative_path) VALUES (2, 1, 'b.jpg');
			 INSERT INTO tags (id, name, parent_id, created_at) VALUES (1, 'sunset', NULL, 100);
			 INSERT INTO tags (id, name, parent_id, created_at) VALUES (2, 'travel', NULL, 200);
			 INSERT INTO asset_tags VALUES (1, 1), (1, 2), (2, 1);",
		)
		.unwrap();

		// Apply migration 4
		apply_migrations(&conn).unwrap();

		let mut stmt = conn
			.prepare(
				"SELECT asset_id, value FROM garnet_metadata WHERE key='tags'
				 ORDER BY asset_id, value",
			)
			.unwrap();
		let rows: Vec<(i64, String)> = stmt
			.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
			.unwrap()
			.collect::<Result<_, _>>()
			.unwrap();
		assert_eq!(
			rows,
			vec![
				(1, "sunset".to_string()),
				(1, "travel".to_string()),
				(2, "sunset".to_string()),
			]
		);
	}

	#[test]
	fn v2_tables_exist() {
		let conn = Connection::open_in_memory().unwrap();
		apply_migrations(&conn).unwrap();
		for table in [
			"library_roots",
			"assets",
			"asset_metadata",
			"garnet_metadata",
			"collections",
			"collection_assets",
			"pinned_sources",
		] {
			conn.query_row(
				"SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?1",
				[table],
				|r| r.get::<_, i64>(0),
			)
			.unwrap_or_else(|_| panic!("missing table {table}"));
		}
		// Tag tables should be dropped by migration 4.
		for dropped in ["tags", "asset_tags"] {
			let exists: i64 = conn
				.query_row(
					"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
					[dropped],
					|r| r.get(0),
				)
				.unwrap();
			assert_eq!(exists, 0, "table {dropped} should have been dropped");
		}
		// content_hash column exists on assets
		let mut stmt = conn.prepare("PRAGMA table_info(assets)").unwrap();
		let cols: Vec<String> = stmt
			.query_map([], |r| r.get::<_, String>(1))
			.unwrap()
			.collect::<Result<_, _>>()
			.unwrap();
		assert!(cols.contains(&"content_hash".to_string()));
	}
}

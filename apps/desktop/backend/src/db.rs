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
static MIGRATIONS: &[(i64, &str)] = &[
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
];

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Backend for the Music Library plugin. Reads the indexed audio assets +
//! their `audio.*` metadata (extracted by the base indexer via lofty) and
//! groups them into an album/artist tree the workflow renders. Album art is
//! handled in the sibling `art` module; native playback + waveform peaks in
//! `audio`/`audio_decoder`/`peaks`.

pub mod art;

pub use art::load_album_art;

use crate::AppState;
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

/// Audio extensions the Music Library shows when no explicit filter is set.
/// Mirrors the indexer's `AUDIO_EXTS` (minus MIDI, which has no tags/audio).
const DEFAULT_AUDIO_EXTS: &[&str] = &[
	"mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus", "wma", "aif", "aiff", "ape", "ac3",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Track {
	pub asset_id: i64,
	pub abs_path: String,
	pub title: String,
	pub artist: String,
	pub album: String,
	pub album_artist: String,
	pub track_no: Option<u32>,
	pub disc_no: Option<u32>,
	pub duration_secs: Option<u64>,
	pub year: Option<u32>,
	pub format: Option<String>,
	pub has_cover: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Album {
	/// Synthetic stable key: `album_artist`\u{1}`album`.
	pub id: String,
	pub album: String,
	pub album_artist: String,
	pub year: Option<u32>,
	pub track_count: usize,
	pub total_duration_secs: u64,
	/// A representative track used to source the album cover (embedded art or a
	/// folder image next to it).
	pub cover_asset_id: i64,
	pub cover_abs_path: String,
	pub tracks: Vec<Track>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MusicLibrary {
	pub albums: Vec<Album>,
	pub track_count: usize,
}

const UNKNOWN_ARTIST: &str = "Unknown Artist";
const UNKNOWN_ALBUM: &str = "Unknown Album";

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

fn filename_title(abs_path: &str) -> String {
	std::path::Path::new(abs_path)
		.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or("Untitled")
		.to_string()
}

/// Build the shared `WHERE` clause scoping to in-filter audio assets, optionally
/// beneath a folder. Returns the clause (starting with `WHERE`) and its params.
fn scope_where(formats: &[String], under_path: Option<&str>) -> (String, Vec<Box<dyn ToSql>>) {
	let mut sql = String::from("WHERE a.format IN (");
	sql.push_str(&vec!["?"; formats.len()].join(","));
	sql.push(')');
	let mut params: Vec<Box<dyn ToSql>> = Vec::new();
	for f in formats {
		params.push(Box::new(f.to_ascii_lowercase()));
	}
	if let Some(folder) = under_path {
		let f = folder.trim_end_matches('/');
		if !f.is_empty() {
			sql.push_str(
				" AND ((r.path || '/' || a.relative_path) = ? \
				  OR (r.path || '/' || a.relative_path) LIKE ? || '/%')",
			);
			params.push(Box::new(f.to_string()));
			params.push(Box::new(f.to_string()));
		}
	}
	(sql, params)
}

pub fn list_music_library_impl(
	conn: &Connection,
	under_path: Option<&str>,
	formats: Option<&[String]>,
) -> rusqlite::Result<MusicLibrary> {
	// Resolve the active format set: an explicit (non-empty) filter wins,
	// otherwise the full default audio set.
	let fmts: Vec<String> = match formats {
		Some(f) if !f.is_empty() => f.to_vec(),
		_ => DEFAULT_AUDIO_EXTS.iter().map(|s| s.to_string()).collect(),
	};
	let (where_sql, where_params) = scope_where(&fmts, under_path);
	let params_ref: Vec<&dyn ToSql> = where_params.iter().map(|b| b.as_ref()).collect();

	// 1. In-scope audio assets.
	let asset_sql = format!(
		"SELECT a.id, r.path || '/' || a.relative_path, a.format
		 FROM assets a JOIN library_roots r ON r.id = a.root_id
		 {where_sql} ORDER BY a.id"
	);
	let mut stmt = conn.prepare(&asset_sql)?;
	let rows = stmt
		.query_map(params_ref.as_slice(), |r| {
			Ok((
				r.get::<_, i64>(0)?,
				r.get::<_, String>(1)?,
				r.get::<_, Option<String>>(2)?,
			))
		})?
		.collect::<rusqlite::Result<Vec<_>>>()?;

	// 2. Their `audio.*` metadata, in one join (no 999-param IN list).
	let meta_sql = format!(
		"SELECT m.asset_id, m.key, m.value
		 FROM asset_metadata m
		 JOIN assets a ON a.id = m.asset_id
		 JOIN library_roots r ON r.id = a.root_id
		 {where_sql} AND m.key LIKE 'audio.%'"
	);
	let mut meta_map: HashMap<i64, HashMap<String, String>> = HashMap::new();
	{
		let mut mstmt = conn.prepare(&meta_sql)?;
		let mrows = mstmt.query_map(params_ref.as_slice(), |r| {
			Ok((
				r.get::<_, i64>(0)?,
				r.get::<_, String>(1)?,
				r.get::<_, String>(2)?,
			))
		})?;
		for row in mrows {
			let (id, key, value) = row?;
			meta_map.entry(id).or_default().insert(key, value);
		}
	}

	// 3. Build tracks from assets + metadata, with sensible fallbacks.
	let tracks: Vec<Track> = rows
		.into_iter()
		.map(|(id, abs_path, format)| {
			let md = meta_map.get(&id);
			let get = |k: &str| md.and_then(|m| m.get(k)).cloned();
			let artist = get("audio.artist").unwrap_or_else(|| UNKNOWN_ARTIST.to_string());
			let album_artist = get("audio.album_artist").unwrap_or_else(|| artist.clone());
			Track {
				title: get("audio.title").unwrap_or_else(|| filename_title(&abs_path)),
				artist,
				album: get("audio.album").unwrap_or_else(|| UNKNOWN_ALBUM.to_string()),
				album_artist,
				track_no: get("audio.track").and_then(|s| s.parse().ok()),
				disc_no: get("audio.disc").and_then(|s| s.parse().ok()),
				duration_secs: get("audio.duration_secs").and_then(|s| s.parse().ok()),
				year: get("audio.year").and_then(|s| s.parse().ok()),
				has_cover: md.map(|m| m.contains_key("audio.has_cover")).unwrap_or(false),
				asset_id: id,
				abs_path,
				format,
			}
		})
		.collect();

	let track_count = tracks.len();
	let albums = group_tracks(tracks);
	Ok(MusicLibrary {
		albums,
		track_count,
	})
}

/// Pure grouping: collapse a flat track list into albums keyed by
/// `(album_artist, album)`. Tracks within an album sort by `(disc, track,
/// title)`; albums sort by `(album_artist, year, album)`. Each album's cover
/// comes from the first track carrying embedded art (else the first track, so a
/// folder-image fallback can still be found next to it).
pub fn group_tracks(tracks: Vec<Track>) -> Vec<Album> {
	let mut groups: HashMap<(String, String), Vec<Track>> = HashMap::new();
	for t in tracks {
		groups
			.entry((t.album_artist.clone(), t.album.clone()))
			.or_default()
			.push(t);
	}

	let mut albums: Vec<Album> = groups
		.into_iter()
		.map(|((album_artist, album), mut tracks)| {
			tracks.sort_by(|a, b| {
				a.disc_no
					.unwrap_or(0)
					.cmp(&b.disc_no.unwrap_or(0))
					.then(a.track_no.unwrap_or(0).cmp(&b.track_no.unwrap_or(0)))
					.then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
			});
			let total_duration_secs = tracks.iter().filter_map(|t| t.duration_secs).sum();
			let year = tracks.iter().filter_map(|t| t.year).min();
			let cover = tracks
				.iter()
				.find(|t| t.has_cover)
				.unwrap_or(&tracks[0]);
			Album {
				id: format!("{album_artist}\u{1}{album}"),
				cover_asset_id: cover.asset_id,
				cover_abs_path: cover.abs_path.clone(),
				track_count: tracks.len(),
				total_duration_secs,
				year,
				album,
				album_artist,
				tracks,
			}
		})
		.collect();

	albums.sort_by(|a, b| {
		a.album_artist
			.to_lowercase()
			.cmp(&b.album_artist.to_lowercase())
			.then(a.year.unwrap_or(0).cmp(&b.year.unwrap_or(0)))
			.then_with(|| a.album.to_lowercase().cmp(&b.album.to_lowercase()))
	});
	albums
}

#[tauri::command]
pub fn list_music_library(
	state: State<AppState>,
	under_path: Option<String>,
	formats: Option<Vec<String>>,
) -> Result<MusicLibrary, String> {
	let conn = state.db.lock().map_err(stringify)?;
	list_music_library_impl(&conn, under_path.as_deref(), formats.as_deref()).map_err(stringify)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn track(asset_id: i64, album_artist: &str, album: &str, track_no: u32, title: &str) -> Track {
		Track {
			asset_id,
			abs_path: format!("/m/{album_artist}/{album}/{title}.mp3"),
			title: title.into(),
			artist: album_artist.into(),
			album: album.into(),
			album_artist: album_artist.into(),
			track_no: Some(track_no),
			disc_no: None,
			duration_secs: Some(180),
			year: Some(2000),
			format: Some("mp3".into()),
			has_cover: false,
		}
	}

	#[test]
	fn groups_tracks_into_albums() {
		let tracks = vec![
			track(1, "Beta", "Second", 2, "B2"),
			track(2, "Alpha", "First", 1, "A1"),
			track(3, "Beta", "Second", 1, "B1"),
		];
		let albums = group_tracks(tracks);
		assert_eq!(albums.len(), 2);
		// Albums sorted by album_artist: Alpha before Beta.
		assert_eq!(albums[0].album_artist, "Alpha");
		assert_eq!(albums[1].album_artist, "Beta");
		// Beta/Second has two tracks, ordered by track number.
		assert_eq!(albums[1].track_count, 2);
		assert_eq!(albums[1].tracks[0].title, "B1");
		assert_eq!(albums[1].tracks[1].title, "B2");
		assert_eq!(albums[1].total_duration_secs, 360);
	}

	#[test]
	fn cover_prefers_track_with_embedded_art() {
		let mut t1 = track(1, "X", "Y", 1, "one");
		let mut t2 = track(2, "X", "Y", 2, "two");
		t1.has_cover = false;
		t2.has_cover = true;
		let albums = group_tracks(vec![t1, t2]);
		assert_eq!(albums.len(), 1);
		assert_eq!(albums[0].cover_asset_id, 2);
	}

	fn fresh_db() -> Connection {
		let conn = Connection::open_in_memory().unwrap();
		conn.execute_batch(
			"
			CREATE TABLE library_roots (id INTEGER PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
			CREATE TABLE assets (
				id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL, relative_path TEXT NOT NULL,
				size INTEGER, mtime INTEGER, format TEXT
			);
			CREATE TABLE asset_metadata (asset_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
			INSERT INTO library_roots (id, path, added_at) VALUES (1, '/music', 0);
			INSERT INTO assets (id, root_id, relative_path, format) VALUES
				(1, 1, 'A/Album1/01.mp3', 'mp3'),
				(2, 1, 'A/Album1/02.mp3', 'mp3'),
				(3, 1, 'B/cover.jpg',      'jpg');
			INSERT INTO asset_metadata (asset_id, key, value) VALUES
				(1, 'audio.album', 'Album1'), (1, 'audio.album_artist', 'A'), (1, 'audio.track', '1'),
				(2, 'audio.album', 'Album1'), (2, 'audio.album_artist', 'A'), (2, 'audio.track', '2');
			",
		)
		.unwrap();
		conn
	}

	#[test]
	fn list_excludes_non_audio_and_groups() {
		let conn = fresh_db();
		let lib = list_music_library_impl(&conn, None, None).unwrap();
		assert_eq!(lib.track_count, 2); // the jpg is excluded
		assert_eq!(lib.albums.len(), 1);
		assert_eq!(lib.albums[0].album, "Album1");
		assert_eq!(lib.albums[0].tracks.len(), 2);
	}

	#[test]
	fn list_scopes_by_under_path() {
		let conn = fresh_db();
		let lib = list_music_library_impl(&conn, Some("/music/B"), None).unwrap();
		assert_eq!(lib.track_count, 0); // only the jpg lives under /music/B
	}
}

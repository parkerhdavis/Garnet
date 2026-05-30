// SPDX-License-Identifier: AGPL-3.0-or-later
//! Album-art resolution for the Music Library: embedded cover art (via lofty)
//! with a folder-image fallback (cover/folder/front/album.{jpg,jpeg,png,webp}).
//! Results are downscaled and cached as PNGs under
//! `$XDG_CACHE_HOME/garnet/album-art/`, keyed by source path + mtime + size so a
//! file edit invalidates stale art (the same scheme the thumbnail cache uses).
//! Art is resolved straight from the file/folder, independent of the catalog's
//! file filter, so an audio-only music workspace still shows folder covers.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const DEFAULT_SIZE: u32 = 300;
const FOLDER_COVER_STEMS: &[&str] = &["cover", "folder", "front", "album", "albumart"];
const FOLDER_COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

fn cache_dir() -> Result<PathBuf, String> {
	let base = dirs::cache_dir().ok_or_else(|| "no cache dir".to_string())?;
	let dir = base.join("garnet").join("album-art");
	std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir)
}

fn cache_key(abs_path: &str, mtime: Option<i64>, size: u32) -> String {
	let mut h = Sha256::new();
	h.update(abs_path.as_bytes());
	h.update(b"|");
	h.update(mtime.unwrap_or(0).to_le_bytes());
	h.update(b"|");
	h.update(size.to_le_bytes());
	h.update(b"|art");
	hex::encode(h.finalize())
}

/// Resolve album art for a track file. Returns the absolute path of a cached
/// PNG (the frontend wraps it in `convertFileSrc`), or `None` when no embedded
/// or folder art is found.
#[tauri::command]
pub fn load_album_art(
	abs_path: String,
	mtime: Option<i64>,
	size: Option<u32>,
) -> Result<Option<String>, String> {
	let size = size.unwrap_or(DEFAULT_SIZE).clamp(32, 1024);
	let key = cache_key(&abs_path, mtime, size);
	let cache_file = cache_dir()?.join(format!("{key}.png"));
	if cache_file.exists() {
		return Ok(Some(cache_file.to_string_lossy().into_owned()));
	}

	let Some(bytes) = raw_art_bytes(Path::new(&abs_path)) else {
		return Ok(None);
	};
	let Ok(img) = image::load_from_memory(&bytes) else {
		return Ok(None);
	};
	let thumb = img.thumbnail(size, size);
	let mut out: Vec<u8> = Vec::new();
	if thumb
		.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
		.is_err()
	{
		return Ok(None);
	}
	if std::fs::write(&cache_file, &out).is_err() {
		return Ok(None);
	}
	Ok(Some(cache_file.to_string_lossy().into_owned()))
}

/// Raw image bytes for a track: embedded picture first, then a folder cover.
fn raw_art_bytes(track: &Path) -> Option<Vec<u8>> {
	embedded_art(track).or_else(|| folder_cover(track))
}

fn embedded_art(track: &Path) -> Option<Vec<u8>> {
	use lofty::file::TaggedFileExt;
	let tagged = lofty::read_from_path(track).ok()?;
	let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
	let pic = tag.pictures().first()?;
	Some(pic.data().to_vec())
}

fn folder_cover(track: &Path) -> Option<Vec<u8>> {
	let dir = track.parent()?;
	for entry in std::fs::read_dir(dir).ok()?.flatten() {
		let path = entry.path();
		if !path.is_file() {
			continue;
		}
		let stem = path
			.file_stem()
			.and_then(|s| s.to_str())
			.map(|s| s.to_ascii_lowercase());
		let ext = path
			.extension()
			.and_then(|s| s.to_str())
			.map(|s| s.to_ascii_lowercase());
		if let (Some(stem), Some(ext)) = (stem, ext) {
			if FOLDER_COVER_STEMS.contains(&stem.as_str())
				&& FOLDER_COVER_EXTS.contains(&ext.as_str())
			{
				return std::fs::read(&path).ok();
			}
		}
	}
	None
}

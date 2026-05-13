// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thumbnail generation and caching.
//!
//! `get_thumbnail` accepts an absolute path + mtime (caller already has both
//! from the asset row, so the command never has to touch the library DB and
//! can run in parallel under Tauri's async dispatch). Generated PNGs are
//! cached under `$XDG_CACHE_HOME/garnet/thumbnails/` keyed by
//! `sha256(abs_path || mtime || size)`. Including mtime in the key means an
//! edit to the source file naturally invalidates the cache.
//!
//! Only formats the `image` crate handles natively are supported today (png,
//! jpg/jpeg, gif, bmp, tiff, webp). Other formats return `Ok(None)` so the
//! frontend can fall back to a format-based icon without treating it as an
//! error.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::imageops::FilterType;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const DEFAULT_SIZE: u32 = 240;
const SUPPORTED_FORMATS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"];

fn cache_dir() -> Result<PathBuf, String> {
	let base = dirs::cache_dir().ok_or_else(|| "no cache dir".to_string())?;
	let dir = base.join("garnet").join("thumbnails");
	std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir)
}

fn cache_key(abs_path: &str, mtime: Option<i64>, size: u32) -> String {
	let mut hasher = Sha256::new();
	hasher.update(abs_path.as_bytes());
	hasher.update(b"|");
	hasher.update(mtime.unwrap_or(0).to_le_bytes());
	hasher.update(b"|");
	hasher.update(size.to_le_bytes());
	hex::encode(hasher.finalize())
}

fn format_is_image(path: &Path) -> bool {
	path.extension()
		.and_then(|s| s.to_str())
		.map(|s| s.to_ascii_lowercase())
		.is_some_and(|ext| SUPPORTED_FORMATS.contains(&ext.as_str()))
}

#[tauri::command]
pub fn get_thumbnail(
	abs_path: String,
	mtime: Option<i64>,
	size: Option<u32>,
) -> Result<Option<String>, String> {
	let size = size.unwrap_or(DEFAULT_SIZE).clamp(32, 1024);
	let path = PathBuf::from(&abs_path);

	if !format_is_image(&path) {
		return Ok(None);
	}

	let key = cache_key(&abs_path, mtime, size);
	let cache_file = cache_dir()?.join(format!("{key}.png"));

	if cache_file.exists() {
		let bytes = std::fs::read(&cache_file).map_err(|e| e.to_string())?;
		return Ok(Some(BASE64.encode(bytes)));
	}

	let img = match image::open(&path) {
		Ok(i) => i,
		Err(e) => {
			tracing::debug!("thumbnail decode failed for {abs_path}: {e}");
			return Ok(None);
		}
	};

	// Lanczos3 keeps edges crisp; thumbnail's centered crop would change
	// aspect, so resize_exact_within_bounds via `thumbnail` is what we want
	// here (preserves aspect ratio, fits inside size × size).
	let thumb = img.thumbnail(size, size);

	let mut bytes: Vec<u8> = Vec::new();
	thumb
		.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
		.map_err(|e| format!("encode: {e}"))?;

	std::fs::write(&cache_file, &bytes).map_err(|e| e.to_string())?;
	Ok(Some(BASE64.encode(&bytes)))
}

// Touch FilterType so the unused-import lint doesn't fire when we add
// resize-paths later; image::thumbnail picks the filter internally for now.
#[allow(dead_code)]
fn _filter_anchor() -> FilterType {
	FilterType::Lanczos3
}

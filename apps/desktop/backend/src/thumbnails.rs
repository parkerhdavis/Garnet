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
//! Routing by extension:
//!   - Raster image formats (png/jpg/gif/bmp/tiff/webp) → decoded via the
//!     `image` crate and resized in-process.
//!   - Video formats → frame extracted by shelling out to `ffmpeg` (it seeks
//!     to a keyframe reliably; the alternative HTML5-canvas-from-`<video>`
//!     approach was unreliable on webkit2gtk because the GStreamer pipeline
//!     kept presenting stale frames). Returns `Ok(None)` if ffmpeg isn't on
//!     PATH so the frontend can fall back to a format icon.
//!   - Anything else → `Ok(None)`.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::imageops::FilterType;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const DEFAULT_SIZE: u32 = 240;
const IMAGE_FORMATS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"];
const VIDEO_FORMATS: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"];

/// Cap on concurrent ffmpeg subprocesses. A full grid of 60 video tiles
/// otherwise spawns 60 ffmpeg processes simultaneously and each decode runs at
/// 1/60th speed because of CPU oversubscription. Limiting to a small handful
/// lets the first few tiles fill in fast (the user-facing perception) without
/// sacrificing total throughput meaningfully.
const FFMPEG_PARALLELISM: usize = 4;

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

fn ext_lower(path: &Path) -> Option<String> {
	path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase())
}

fn ffmpeg_available() -> bool {
	static AVAILABLE: OnceLock<bool> = OnceLock::new();
	*AVAILABLE.get_or_init(|| {
		Command::new("ffmpeg")
			.arg("-version")
			.output()
			.map(|o| o.status.success())
			.unwrap_or(false)
	})
}

fn extract_image_thumb(path: &Path, size: u32) -> Option<Vec<u8>> {
	let img = image::open(path).ok()?;
	let thumb = img.thumbnail(size, size);
	let mut bytes: Vec<u8> = Vec::new();
	thumb
		.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
		.ok()?;
	Some(bytes)
}

/// Counting semaphore for ffmpeg parallelism. A `Mutex<usize>` plus a `Condvar`
/// would be more idiomatic, but std doesn't ship `Semaphore` and the queue
/// here is small enough that a token-counter under a regular mutex is fine.
fn ffmpeg_slot() -> FfmpegPermit {
	static AVAILABLE: OnceLock<Mutex<usize>> = OnceLock::new();
	let slots = AVAILABLE.get_or_init(|| Mutex::new(FFMPEG_PARALLELISM));
	loop {
		{
			let mut g = slots.lock().unwrap();
			if *g > 0 {
				*g -= 1;
				return FfmpegPermit { slots };
			}
		}
		// Brief backoff before re-checking. Sync Tauri commands run on tokio's
		// blocking pool so blocking the thread here doesn't starve the runtime.
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
}

struct FfmpegPermit {
	slots: &'static Mutex<usize>,
}

impl Drop for FfmpegPermit {
	fn drop(&mut self) {
		let mut g = self.slots.lock().unwrap();
		*g += 1;
	}
}

fn extract_video_thumb(path: &Path, size: u32, cache_file: &Path) -> Option<Vec<u8>> {
	if !ffmpeg_available() {
		tracing::debug!("ffmpeg not on PATH; skipping video thumbnail for {path:?}");
		return None;
	}
	let _permit = ffmpeg_slot();
	// `-ss 1 -i …` seeks before input which is fast (input seek). For very
	// short clips ffmpeg clamps to the available range and still produces a
	// frame. `scale=W:-2` picks an even height so libx264-style encoders
	// don't choke; for PNG output it just guarantees an even dimension.
	let filter = format!("scale='min({size},iw)':-2");
	let out = Command::new("ffmpeg")
		.args([
			"-ss",
			"1",
			"-i",
			&path.to_string_lossy(),
			"-frames:v",
			"1",
			"-vf",
			&filter,
			"-y",
			"-loglevel",
			"error",
		])
		.arg(cache_file)
		.output()
		.ok()?;
	if !out.status.success() {
		let stderr = String::from_utf8_lossy(&out.stderr);
		tracing::debug!("ffmpeg failed for {path:?}: {stderr}");
		return None;
	}
	std::fs::read(cache_file).ok()
}

#[tauri::command]
pub fn get_thumbnail(
	abs_path: String,
	mtime: Option<i64>,
	size: Option<u32>,
) -> Result<Option<String>, String> {
	let size = size.unwrap_or(DEFAULT_SIZE).clamp(32, 1024);
	let path = PathBuf::from(&abs_path);

	let Some(ext) = ext_lower(&path) else {
		return Ok(None);
	};
	let is_image = IMAGE_FORMATS.contains(&ext.as_str());
	let is_video = VIDEO_FORMATS.contains(&ext.as_str());
	if !is_image && !is_video {
		return Ok(None);
	}

	let key = cache_key(&abs_path, mtime, size);
	let cache_file = cache_dir()?.join(format!("{key}.png"));

	if cache_file.exists() {
		let bytes = std::fs::read(&cache_file).map_err(|e| e.to_string())?;
		return Ok(Some(BASE64.encode(bytes)));
	}

	let bytes = if is_image {
		match extract_image_thumb(&path, size) {
			Some(b) => {
				std::fs::write(&cache_file, &b).map_err(|e| e.to_string())?;
				b
			}
			None => return Ok(None),
		}
	} else {
		// extract_video_thumb writes directly to cache_file via ffmpeg, so
		// once it returns Some we can read straight from there.
		match extract_video_thumb(&path, size, &cache_file) {
			Some(b) => b,
			None => return Ok(None),
		}
	};

	Ok(Some(BASE64.encode(&bytes)))
}

#[allow(dead_code)]
fn _filter_anchor() -> FilterType {
	FilterType::Lanczos3
}

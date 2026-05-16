// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thumbnail generation and caching.
//!
//! Two commands, deliberately separated so the UI never waits on a thumbnail:
//!
//! - **`get_thumbnail`** — pure cache lookup. Returns the **absolute path** of
//!   the cached PNG (frontend wraps it in `convertFileSrc` for the `<img>`)
//!   or `None`. Never generates.
//! - **`ensure_thumbnail`** — spawns generation in a background task if the
//!   cache is cold. Emits `thumbnail:ready` (`{abs_path, mtime, size, path}`)
//!   when done. Deduped by cache key so 60 simultaneous calls for the same
//!   key produce one generation. Concurrency-capped so a grid of fresh
//!   thumbnails doesn't saturate every CPU core simultaneously.
//!
//! Cached PNGs live under `$XDG_CACHE_HOME/garnet/thumbnails/` keyed by
//! `sha256(abs_path || mtime || size)`. Including mtime in the key means an
//! edit to the source file naturally invalidates the cache.
//!
//! Routing by extension:
//!   - Raster image formats (png/jpg/gif/bmp/tiff/webp) → decoded via the
//!     `image` crate and resized in-process.
//!   - Video formats → frame extracted by shelling out to `ffmpeg`.
//!   - 3D model formats (gltf/glb/obj/stl/ply/fbx) → cache lookup only here;
//!     generation requires WebGL and happens in the frontend (Three.js).
//!     The frontend posts its rendered PNG back through
//!     `save_model_thumbnail`, which writes to the same cache path scheme
//!     and emits the standard `thumbnail:ready` event.
//!   - Anything else → ignored (frontend shows the format icon fallback).

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::imageops::FilterType;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const DEFAULT_SIZE: u32 = 240;
const IMAGE_FORMATS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"];
const VIDEO_FORMATS: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"];
/// 3D formats the frontend's Three.js thumbnailer can render. Listed here so
/// `get_thumbnail` will return cached PNGs for these extensions even though
/// the backend never generates them itself.
const MODEL_FORMATS: &[&str] = &["gltf", "glb", "obj", "stl", "ply", "fbx"];

/// Cap on concurrent ffmpeg subprocesses. A full grid of 60 video tiles
/// otherwise spawns 60 ffmpeg processes simultaneously and each decode runs at
/// 1/60th speed because of CPU oversubscription. Limiting to a small handful
/// lets the first few tiles fill in fast (the user-facing perception) without
/// sacrificing total throughput meaningfully.
const FFMPEG_PARALLELISM: usize = 4;

/// Cap on concurrent in-process image decodes. Without this, 60 simultaneous
/// `ensure_thumbnail` calls all hit `image::open` at once, saturating every
/// core. The UI thread is unaffected (these run on the blocking pool) but
/// the IPC pipe back to the webview can stall, and ambient app interactions
/// (clicks, scrolls that trigger commands) feel sluggish while generation
/// runs. Four is a reasonable mid-point — fast enough for a cold-cache page
/// to fill in within a couple seconds on most machines, capped enough that
/// the system stays responsive.
const IMAGE_DECODE_PARALLELISM: usize = 4;

#[derive(Serialize, Clone)]
struct ThumbnailReady {
	abs_path: String,
	mtime: Option<i64>,
	size: u32,
	/// Absolute filesystem path to the cached PNG. The frontend wraps it in
	/// `convertFileSrc` to render via Tauri's asset protocol — bypasses the
	/// expensive base64-over-IPC round trip the old API used.
	path: String,
}

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

/// Set of formats `get_thumbnail` will resolve out of the cache. Note this
/// is wider than what `ensure_thumbnail` actually generates — model thumbs
/// are produced by the frontend and arrive here via `save_model_thumbnail`,
/// but the cache file lives in the same path so cache hits look identical.
fn is_thumbnailable(ext: &str) -> bool {
	IMAGE_FORMATS.contains(&ext) || VIDEO_FORMATS.contains(&ext) || MODEL_FORMATS.contains(&ext)
}

fn is_backend_generatable(ext: &str) -> bool {
	IMAGE_FORMATS.contains(&ext) || VIDEO_FORMATS.contains(&ext)
}

fn is_renderable_model(ext: &str) -> bool {
	MODEL_FORMATS.contains(&ext)
}

/// Pure cache lookup. Returns the absolute path of the cached PNG, or `None`
/// if no thumbnail exists yet for this `(abs_path, mtime, size)`. The
/// frontend is expected to call `ensure_thumbnail` after a `None` result if
/// it wants generation to happen.
#[tauri::command]
pub fn get_thumbnail(
	abs_path: String,
	mtime: Option<i64>,
	size: Option<u32>,
) -> Result<Option<String>, String> {
	let size = size.unwrap_or(DEFAULT_SIZE).clamp(32, 1024);
	let path = PathBuf::from(&abs_path);
	let Some(ext) = ext_lower(&path) else { return Ok(None) };
	if !is_thumbnailable(&ext) {
		return Ok(None);
	}
	let key = cache_key(&abs_path, mtime, size);
	let cache_file = cache_dir()?.join(format!("{key}.png"));
	if cache_file.exists() {
		Ok(Some(cache_file.to_string_lossy().into_owned()))
	} else {
		Ok(None)
	}
}

/// Kicks off background generation if the thumbnail isn't already cached.
/// Returns immediately. When generation finishes, fires a `thumbnail:ready`
/// event the frontend can subscribe to. Duplicate calls for the same key
/// while generation is in flight are no-ops.
#[tauri::command]
pub fn ensure_thumbnail(
	abs_path: String,
	mtime: Option<i64>,
	size: Option<u32>,
	app: AppHandle,
) -> Result<(), String> {
	let size = size.unwrap_or(DEFAULT_SIZE).clamp(32, 1024);
	let path = PathBuf::from(&abs_path);
	let Some(ext) = ext_lower(&path) else { return Ok(()) };
	if !is_backend_generatable(&ext) {
		// Model formats need WebGL — generation is the frontend's job. Don't
		// error or warn; the frontend's modelThumbnailer takes over via
		// save_model_thumbnail.
		return Ok(());
	}
	let key = cache_key(&abs_path, mtime, size);
	let cache_file = cache_dir()?.join(format!("{key}.png"));

	// Fast path: already cached. Emit the event anyway so a late-subscribing
	// listener gets the same signal it would for a fresh generation. (The
	// frontend's getThumbnail call usually picks up the cached path on its
	// own, so this is rarely the path taken — but it's defensively cheap.)
	if cache_file.exists() {
		let _ = app.emit(
			"thumbnail:ready",
			ThumbnailReady {
				abs_path,
				mtime,
				size,
				path: cache_file.to_string_lossy().into_owned(),
			},
		);
		return Ok(());
	}

	if !claim_in_progress(&key) {
		// Already generating for this key. The original spawner will emit
		// the event when done; that listener fan-out covers this caller too.
		return Ok(());
	}

	let key_for_task = key.clone();
	let is_image = IMAGE_FORMATS.contains(&ext.as_str());
	tauri::async_runtime::spawn_blocking(move || {
		let ok = if is_image {
			extract_image_thumb(&path, size, &cache_file)
		} else {
			extract_video_thumb(&path, size, &cache_file)
		};
		release_in_progress(&key_for_task);
		if ok {
			let _ = app.emit(
				"thumbnail:ready",
				ThumbnailReady {
					abs_path,
					mtime,
					size,
					path: cache_file.to_string_lossy().into_owned(),
				},
			);
		} else {
			tracing::debug!("thumbnail generation failed for {key_for_task}");
		}
	});

	Ok(())
}

/// Persists a thumbnail PNG rendered by the frontend (Three.js) into the
/// same on-disk cache used by image/video thumbnails. The frontend hands us
/// the absolute path + mtime + size so the cache key matches what
/// `get_thumbnail` would look up on the next visit. Emits `thumbnail:ready`
/// after a successful write so any AssetThumbnail subscribed to this key
/// picks up the path via `thumbnailBus` and swaps in the new image.
#[tauri::command]
pub fn save_model_thumbnail(
	abs_path: String,
	mtime: Option<i64>,
	size: Option<u32>,
	png_base64: String,
	app: AppHandle,
) -> Result<(), String> {
	let size = size.unwrap_or(DEFAULT_SIZE).clamp(32, 1024);
	let path = PathBuf::from(&abs_path);
	let ext = ext_lower(&path).ok_or_else(|| "missing extension".to_string())?;
	if !is_renderable_model(&ext) {
		return Err(format!("save_model_thumbnail: {ext} is not a renderable model format"));
	}
	let bytes = BASE64
		.decode(png_base64.as_bytes())
		.map_err(|e| format!("invalid base64 PNG: {e}"))?;
	let key = cache_key(&abs_path, mtime, size);
	let cache_file = cache_dir()?.join(format!("{key}.png"));
	std::fs::write(&cache_file, &bytes).map_err(|e| e.to_string())?;

	let _ = app.emit(
		"thumbnail:ready",
		ThumbnailReady {
			abs_path,
			mtime,
			size,
			path: cache_file.to_string_lossy().into_owned(),
		},
	);
	Ok(())
}

/// Process-wide set of cache keys whose generation is currently in flight.
/// Prevents two `ensure_thumbnail` callers from racing each other and doing
/// the same work twice (which would also race on the cache file write).
fn in_progress() -> &'static Mutex<HashSet<String>> {
	static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
	SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn claim_in_progress(key: &str) -> bool {
	match in_progress().lock() {
		Ok(mut g) => g.insert(key.to_string()),
		Err(_) => false,
	}
}

fn release_in_progress(key: &str) {
	if let Ok(mut g) = in_progress().lock() {
		g.remove(key);
	}
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

/// Counting-semaphore permit. A `Mutex<usize>` plus a small backoff loop —
/// std doesn't ship `Semaphore` and the queue here is small enough that a
/// token-counter under a regular mutex is fine. The blocking pool has more
/// threads than we'd ever park, so this is safe.
struct Permit {
	slots: &'static Mutex<usize>,
}
impl Drop for Permit {
	fn drop(&mut self) {
		if let Ok(mut g) = self.slots.lock() {
			*g += 1;
		}
	}
}
fn acquire(slot: &'static Mutex<usize>) -> Permit {
	loop {
		{
			let mut g = match slot.lock() {
				Ok(g) => g,
				Err(_) => return Permit { slots: slot },
			};
			if *g > 0 {
				*g -= 1;
				return Permit { slots: slot };
			}
		}
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
}

fn ffmpeg_slot() -> Permit {
	static AVAILABLE: OnceLock<Mutex<usize>> = OnceLock::new();
	acquire(AVAILABLE.get_or_init(|| Mutex::new(FFMPEG_PARALLELISM)))
}

fn image_slot() -> Permit {
	static AVAILABLE: OnceLock<Mutex<usize>> = OnceLock::new();
	acquire(AVAILABLE.get_or_init(|| Mutex::new(IMAGE_DECODE_PARALLELISM)))
}

fn extract_image_thumb(path: &Path, size: u32, cache_file: &Path) -> bool {
	let _permit = image_slot();
	let Ok(img) = image::open(path) else { return false };
	let thumb = img.thumbnail(size, size);
	let mut bytes: Vec<u8> = Vec::new();
	if thumb
		.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
		.is_err()
	{
		return false;
	}
	std::fs::write(cache_file, &bytes).is_ok()
}

fn extract_video_thumb(path: &Path, size: u32, cache_file: &Path) -> bool {
	if !ffmpeg_available() {
		tracing::debug!("ffmpeg not on PATH; skipping video thumbnail for {path:?}");
		return false;
	}
	let _permit = ffmpeg_slot();
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
		.output();
	let Ok(out) = out else { return false };
	if !out.status.success() {
		let stderr = String::from_utf8_lossy(&out.stderr);
		tracing::debug!("ffmpeg failed for {path:?}: {stderr}");
		return false;
	}
	true
}

#[allow(dead_code)]
fn _filter_anchor() -> FilterType {
	FilterType::Lanczos3
}

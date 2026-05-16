// SPDX-License-Identifier: AGPL-3.0-or-later
//! Editor pipeline: an ordered list of operations applied to a source
//! image. The frontend sends a JSON array of `Operation` values; the
//! backend replays them from the original image on every preview/commit
//! (cheap because there's only ever one image in play).
//!
//! Why replay from the original instead of caching intermediates: the op
//! list is small (typically <10 items), users undo/redo freely, and
//! incremental caches add a lot of state for very little win at this
//! scale. Revisit if perf becomes a bottleneck on large images.

use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};

use super::adjust::{apply_brightness, apply_contrast, apply_hue, apply_luminance_curve, apply_saturation};
use super::io::{encode_to_base64_png, load_dynamic_image, maybe_resize, save_image};
use super::transform::{corner_round, crop, resize, rotate};

/// Process-wide cache for the decoded + downscaled preview source.
///
/// Why this matters: every slider tick triggers a `preview_edit` call. The
/// original was decoding the full multi-MP JPEG and re-running the
/// downscale on every call, which made even cheap pipelines feel laggy on
/// large images. Caching the resized `DynamicImage` collapses subsequent
/// calls to "apply pipeline + encode PNG" — bounded by the preview-size
/// cap, not the source size.
///
/// Cache is single-slot (path + max_size) because the editor only ever
/// edits one image at a time; opening a different asset evicts the old
/// entry. `Arc<DynamicImage>` so concurrent calls share one allocation —
/// each clone is a refcount bump, not a pixel copy.
struct PreviewSourceCache {
	path: String,
	max_size: Option<u32>,
	image: Arc<DynamicImage>,
}

fn preview_cache() -> &'static Mutex<Option<PreviewSourceCache>> {
	static CELL: OnceLock<Mutex<Option<PreviewSourceCache>>> = OnceLock::new();
	CELL.get_or_init(|| Mutex::new(None))
}

fn load_or_cache_preview_source(
	path: &str,
	max_size: Option<u32>,
) -> Result<Arc<DynamicImage>, String> {
	let mut guard = preview_cache()
		.lock()
		.map_err(|e| format!("preview cache poisoned: {e}"))?;
	if let Some(c) = guard.as_ref() {
		if c.path == path && c.max_size == max_size {
			return Ok(Arc::clone(&c.image));
		}
	}
	// Decode + resize while holding the lock — serializes concurrent
	// preview calls during the slow first decode (which is what we want;
	// they'd all be loading the same file). Slider-drag latency comes
	// from this branch *once* per editor session.
	let img = Arc::new(maybe_resize(load_dynamic_image(path)?, max_size));
	*guard = Some(PreviewSourceCache {
		path: path.to_string(),
		max_size,
		image: Arc::clone(&img),
	});
	Ok(img)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operation {
	/// Hue offset in degrees; positive shifts toward green.
	AdjustHue { offset: f32 },
	/// Saturation offset in [-1, 1].
	AdjustSaturation { offset: f32 },
	/// Brightness offset in [-1, 1].
	AdjustBrightness { offset: f32 },
	/// Contrast amount in [-1, 1]; 0 is identity.
	AdjustContrast { amount: f32 },
	/// Arbitrary 256-entry luminance LUT.
	LuminanceCurve { lut: Vec<u8> },
	/// Axis-aligned crop.
	Crop { x: u32, y: u32, w: u32, h: u32 },
	/// Resize to exact pixel dimensions.
	Resize { w: u32, h: u32 },
	/// Rotate by degrees (clockwise; 90° multiples are pixel-perfect).
	Rotate { angle: f32 },
	/// Round corners by `radius` px; transparent outside the rounded rect.
	CornerRound { radius: u32 },
}

pub fn apply_pipeline(img: &DynamicImage, ops: &[Operation]) -> Result<DynamicImage, String> {
	if ops.is_empty() {
		return Ok(img.clone());
	}
	let mut current = apply_one(img, &ops[0])?;
	for op in &ops[1..] {
		current = apply_one(&current, op)?;
	}
	Ok(current)
}

fn apply_one(img: &DynamicImage, op: &Operation) -> Result<DynamicImage, String> {
	match op {
		Operation::AdjustHue { offset } => {
			Ok(DynamicImage::ImageRgba8(apply_hue(img.to_rgba8(), *offset)))
		}
		Operation::AdjustSaturation { offset } => {
			Ok(DynamicImage::ImageRgba8(apply_saturation(img.to_rgba8(), *offset)))
		}
		Operation::AdjustBrightness { offset } => {
			Ok(DynamicImage::ImageRgba8(apply_brightness(img.to_rgba8(), *offset)))
		}
		Operation::AdjustContrast { amount } => {
			Ok(DynamicImage::ImageRgba8(apply_contrast(img.to_rgba8(), *amount)))
		}
		Operation::LuminanceCurve { lut } => {
			if lut.len() != 256 {
				return Err(format!("LUT must have 256 entries, got {}", lut.len()));
			}
			let mut arr = [0u8; 256];
			arr.copy_from_slice(lut);
			Ok(DynamicImage::ImageRgba8(apply_luminance_curve(img.to_rgba8(), &arr)))
		}
		Operation::Crop { x, y, w, h } => Ok(crop(img, *x, *y, *w, *h)),
		Operation::Resize { w, h } => resize(img, *w, *h),
		Operation::Rotate { angle } => Ok(rotate(img, *angle)),
		Operation::CornerRound { radius } => Ok(corner_round(img, *radius)),
	}
}

/// Apply the pipeline at a downscaled preview size and return a base64
/// PNG. `max_preview_size` is the longest-axis cap before the pipeline
/// runs, so slider drags stay snappy on multi-megapixel images. Uses the
/// session-wide preview cache to avoid re-decoding the source on every
/// call — first call pays the decode, subsequent calls just re-apply.
#[tauri::command]
pub async fn preview_edit(
	path: String,
	ops: Vec<Operation>,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = load_or_cache_preview_source(&path, max_preview_size)?;
		let result = apply_pipeline(&img, &ops)?;
		encode_to_base64_png(&result)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

/// Apply the pipeline at full resolution and write to disk. Caller chooses
/// `output_path` (which may equal `path` to overwrite) and `format`.
/// Bypasses the preview cache — commits must run on the original-resolution
/// image, not the downscaled preview copy.
#[tauri::command]
pub async fn commit_edit(
	path: String,
	ops: Vec<Operation>,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let img = load_dynamic_image(&path)?;
		let result = apply_pipeline(&img, &ops)?;
		save_image(&result, &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::{GenericImageView, Rgba, RgbaImage};

	fn solid(w: u32, h: u32, color: [u8; 4]) -> DynamicImage {
		DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(color)))
	}

	#[test]
	fn empty_pipeline_is_identity() {
		let img = solid(4, 4, [200, 100, 50, 255]);
		let out = apply_pipeline(&img, &[]).unwrap();
		assert_eq!(out.to_rgba8(), img.to_rgba8());
	}

	#[test]
	fn crop_then_resize_composes() {
		let img = solid(100, 100, [200, 100, 50, 255]);
		let out = apply_pipeline(
			&img,
			&[
				Operation::Crop { x: 10, y: 10, w: 50, h: 50 },
				Operation::Resize { w: 25, h: 25 },
			],
		)
		.unwrap();
		assert_eq!(out.dimensions(), (25, 25));
	}

	#[test]
	fn rotate_then_corner_round_keeps_dims() {
		let img = solid(20, 20, [255, 255, 255, 255]);
		let out = apply_pipeline(
			&img,
			&[Operation::Rotate { angle: 90.0 }, Operation::CornerRound { radius: 4 }],
		)
		.unwrap();
		assert_eq!(out.dimensions(), (20, 20));
	}

	#[test]
	fn lut_wrong_length_errors() {
		let img = solid(4, 4, [0, 0, 0, 255]);
		let err = apply_pipeline(&img, &[Operation::LuminanceCurve { lut: vec![0; 100] }]);
		assert!(err.is_err());
	}

	#[test]
	fn preview_cache_hits_for_same_path() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("c.png");
		solid(64, 64, [10, 20, 30, 255])
			.save(&path)
			.unwrap();
		let p = path.to_str().unwrap();
		let a = load_or_cache_preview_source(p, Some(32)).unwrap();
		let b = load_or_cache_preview_source(p, Some(32)).unwrap();
		// Same Arc allocation = same cached entry (refcount, not re-decode).
		assert!(Arc::ptr_eq(&a, &b));
	}

	#[test]
	fn preview_cache_misses_on_size_change() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("c2.png");
		solid(64, 64, [10, 20, 30, 255])
			.save(&path)
			.unwrap();
		let p = path.to_str().unwrap();
		let a = load_or_cache_preview_source(p, Some(32)).unwrap();
		let b = load_or_cache_preview_source(p, Some(16)).unwrap();
		assert!(!Arc::ptr_eq(&a, &b));
	}

	#[test]
	fn operation_json_roundtrip() {
		let ops = vec![
			Operation::AdjustHue { offset: 30.0 },
			Operation::Crop { x: 1, y: 2, w: 10, h: 20 },
			Operation::Rotate { angle: 45.0 },
		];
		let json = serde_json::to_string(&ops).unwrap();
		// snake_case tag so the frontend can build operations with plain
		// string literals matching the Rust variant names.
		assert!(json.contains("\"type\":\"adjust_hue\""));
		assert!(json.contains("\"type\":\"crop\""));
		let decoded: Vec<Operation> = serde_json::from_str(&json).unwrap();
		assert_eq!(decoded.len(), 3);
	}
}

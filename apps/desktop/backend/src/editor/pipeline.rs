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

use image::{DynamicImage, Rgba32FImage};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::adjust::{
	apply_brightness, apply_contrast, apply_hue, apply_luminance_curve, apply_saturation,
	apply_temperature, apply_tint,
};
use super::io::{load_dynamic_image, maybe_resize, save_image};
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
	/// White-balance temperature in [-1, 1]; positive = warmer.
	AdjustTemperature { amount: f32 },
	/// White-balance tint in [-1, 1]; positive = magenta, negative = green.
	AdjustTint { amount: f32 },
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
	// Promote to a normalized f32 working buffer once, run every op in f32 so
	// chained adjustments lose no precision, and let `save_image` quantize to
	// the chosen output depth. `to_rgba32f` normalizes 8/16-bit sources to
	// 0..1 and passes f32/EXR sources through unchanged.
	let ordered = reorder_for_preview_parity(ops);
	let mut buf = img.to_rgba32f();
	for op in &ordered {
		buf = apply_one(buf, op)?;
	}
	Ok(DynamicImage::ImageRgba32F(buf))
}

/// Canonicalize op order to match the live CSS-filter preview, so the saved
/// file looks like what the editor showed. The preview's `filter:` chain always
/// applies the luminance curve and white-balance *after* the hue/sat/
/// brightness/contrast primitives (they're separate SVG filters appended last),
/// and the geometric transforms wrap the already-filtered image. Relative order
/// within each group is preserved. Color ops are per-pixel so reordering them
/// ahead of geometry doesn't change the result; reordering curve/white-balance
/// to the end is what fixes the preview-vs-save mismatch.
fn reorder_for_preview_parity(ops: &[Operation]) -> Vec<Operation> {
	let mut color = Vec::new();
	let mut curve = Vec::new();
	let mut white_balance = Vec::new();
	let mut geometry = Vec::new();
	for op in ops {
		match op {
			Operation::AdjustHue { .. }
			| Operation::AdjustSaturation { .. }
			| Operation::AdjustBrightness { .. }
			| Operation::AdjustContrast { .. } => color.push(op.clone()),
			Operation::LuminanceCurve { .. } => curve.push(op.clone()),
			Operation::AdjustTemperature { .. } | Operation::AdjustTint { .. } => {
				white_balance.push(op.clone())
			}
			Operation::Crop { .. }
			| Operation::Resize { .. }
			| Operation::Rotate { .. }
			| Operation::CornerRound { .. } => geometry.push(op.clone()),
		}
	}
	color
		.into_iter()
		.chain(curve)
		.chain(white_balance)
		.chain(geometry)
		.collect()
}

fn apply_one(img: Rgba32FImage, op: &Operation) -> Result<Rgba32FImage, String> {
	Ok(match op {
		Operation::AdjustHue { offset } => apply_hue(img, *offset),
		Operation::AdjustSaturation { offset } => apply_saturation(img, *offset),
		Operation::AdjustBrightness { offset } => apply_brightness(img, *offset),
		Operation::AdjustContrast { amount } => apply_contrast(img, *amount),
		Operation::AdjustTemperature { amount } => apply_temperature(img, *amount),
		Operation::AdjustTint { amount } => apply_tint(img, *amount),
		Operation::LuminanceCurve { lut } => {
			if lut.len() != 256 {
				return Err(format!("LUT must have 256 entries, got {}", lut.len()));
			}
			let mut arr = [0u8; 256];
			arr.copy_from_slice(lut);
			apply_luminance_curve(img, &arr)
		}
		Operation::Crop { x, y, w, h } => crop(&img, *x, *y, *w, *h),
		Operation::Resize { w, h } => resize(&img, *w, *h)?,
		Operation::Rotate { angle } => rotate(&img, *angle),
		Operation::CornerRound { radius } => corner_round(&img, *radius),
	})
}

/// Apply the pipeline at a downscaled preview size and return the
/// absolute path of a freshly written PNG file in the OS temp dir.
/// The frontend renders this via the localhost media server, avoiding
/// the multi-megabyte base64 IPC payload that PNG/base64 would impose
/// for previews of multi-MP images.
///
/// Each call writes a uniquely numbered file and deletes the previous
/// one — so /tmp accumulates at most one preview at a time per editor
/// session.
#[tauri::command]
pub async fn preview_edit(
	path: String,
	ops: Vec<Operation>,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = load_or_cache_preview_source(&path, max_preview_size)?;
		let result = apply_pipeline(&img, &ops)?;
		let out = next_preview_path();
		result
			.to_rgba8()
			.save(&out)
			.map_err(|e| format!("Failed to write preview: {}", e))?;
		rotate_preview_file(out.clone());
		Ok(out.to_string_lossy().into_owned())
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

fn next_preview_path() -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir().join(format!("garnet-preview-{}.png", n))
}

/// Track the most recently written preview path and delete the prior
/// one once a fresh file has been written. Bounded /tmp footprint.
fn rotate_preview_file(new_path: PathBuf) {
	static LAST: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
	let cell = LAST.get_or_init(|| Mutex::new(None));
	if let Ok(mut guard) = cell.lock() {
		if let Some(prev) = guard.replace(new_path) {
			let _ = std::fs::remove_file(prev);
		}
	}
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
	fn pipeline_preserves_subbyte_precision() {
		// 512 distinct 16-bit gray levels — more than 8 bits can represent.
		let mut src = image::ImageBuffer::<image::Rgba<u16>, Vec<u16>>::new(512, 1);
		for (x, _y, p) in src.enumerate_pixels_mut() {
			let v = (x * 128) as u16;
			*p = image::Rgba([v, v, v, 65535]);
		}
		let src = DynamicImage::ImageRgba16(src);
		// A gentle contrast stays monotonic and avoids clamping mid-range, so
		// distinct inputs stay distinct.
		let out = apply_pipeline(&src, &[Operation::AdjustContrast { amount: 0.1 }]).unwrap();
		let out16 = out.to_rgba16();
		let distinct: std::collections::HashSet<u16> = out16.pixels().map(|p| p[0]).collect();
		// An 8-bit pipeline would collapse these to ≤256 distinct levels.
		assert!(
			distinct.len() > 256,
			"expected >256 distinct 16-bit levels, got {}",
			distinct.len()
		);
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

/// Wall-time benchmark for the commit path (apply_pipeline + encode), used to
/// gauge the cost of the f32 precision upgrade against the prior 8-bit path.
/// Ignored by default — run explicitly:
///   cargo test -p garnet --release bench_commit -- --ignored --nocapture
/// `GARNET_BENCH_8K=1` adds the 8K case (~4 GB+ working buffers).
#[cfg(test)]
mod bench {
	use super::*;
	use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba, RgbaImage};
	use std::time::Instant;

	fn grad_rgba8(side: u32) -> DynamicImage {
		let mut img = RgbaImage::new(side, side);
		for (x, y, p) in img.enumerate_pixels_mut() {
			*p = Rgba([
				(x % 256) as u8,
				(y % 256) as u8,
				((x + y) % 256) as u8,
				255,
			]);
		}
		DynamicImage::ImageRgba8(img)
	}

	fn grad_rgba16(side: u32) -> DynamicImage {
		let mut img: ImageBuffer<Rgba<u16>, Vec<u16>> = ImageBuffer::new(side, side);
		for (x, y, p) in img.enumerate_pixels_mut() {
			// 16-bit gradient with sub-8-bit steps to expose precision loss.
			*p = Rgba([
				((x * 257) % 65536) as u16,
				((y * 257) % 65536) as u16,
				(((x + y) * 131) % 65536) as u16,
				65535,
			]);
		}
		DynamicImage::ImageRgba16(img)
	}

	fn rep_ops() -> Vec<Operation> {
		// Representative "photo edit": tonal curve + hue + contrast.
		let lut: Vec<u8> = (0..256).map(|i| i as u8).collect();
		vec![
			Operation::LuminanceCurve { lut },
			Operation::AdjustHue { offset: 18.0 },
			Operation::AdjustContrast { amount: 0.25 },
		]
	}

	fn time_case(label: &str, src: &DynamicImage, ops: &[Operation], fmt: &str) {
		let ext = match fmt {
			"png8" | "png16" => "png",
			"jpg" | "jpeg" => "jpg",
			"tiff16" => "tiff",
			other => other,
		};
		let tmp = std::env::temp_dir()
			.join(format!("garnet-bench-{}.{}", label.replace(' ', "_"), ext));
		// Warm one pass (allocator, rayon pool) then time the next.
		let _ = apply_pipeline(src, ops).unwrap();
		let t0 = Instant::now();
		let result = apply_pipeline(src, ops).unwrap();
		let proc_ms = t0.elapsed().as_secs_f64() * 1000.0;
		let t1 = Instant::now();
		save_image(&result, tmp.to_str().unwrap(), fmt).unwrap();
		let save_ms = t1.elapsed().as_secs_f64() * 1000.0;
		let _ = std::fs::remove_file(&tmp);
		println!(
			"{:<28} process={:>8.1}ms  save({})={:>8.1}ms  total={:>8.1}ms",
			label,
			proc_ms,
			fmt,
			save_ms,
			proc_ms + save_ms
		);
	}

	fn mean_rgb(img: &DynamicImage) -> (f64, f64, f64) {
		let rgb = img.to_rgb8();
		let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
		for p in rgb.pixels() {
			r += p[0] as u64;
			g += p[1] as u64;
			b += p[2] as u64;
		}
		let n = rgb.pixels().len() as f64;
		(r as f64 / n, g as f64 / n, b as f64 / n)
	}

	/// Repro for the "slow save + corrupted output" reports. Loads the real
	/// image, applies a warm/bright edit, times each stage, writes PNG+JPG to
	/// /tmp for visual inspection, and prints channel means.
	#[test]
	#[ignore]
	fn repro_commit_real() {
		// Local diagnostic: point GARNET_REPRO_IMAGE at any image to profile the
		// commit path + eyeball /tmp/garnet-repro.png. Skips if unset/missing.
		let Ok(path) = std::env::var("GARNET_REPRO_IMAGE") else {
			println!("[repro] set GARNET_REPRO_IMAGE to run");
			return;
		};
		if !std::path::Path::new(&path).exists() {
			println!("[repro] {path} not found; skipping");
			return;
		}
		let t0 = Instant::now();
		let src = load_dynamic_image(&path).unwrap();
		let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
		let (sw, sh) = src.dimensions();
		let ops = vec![
			Operation::AdjustHue { offset: 50.0 },
			Operation::AdjustSaturation { offset: 0.4 },
			Operation::AdjustBrightness { offset: 0.3 },
			Operation::AdjustTemperature { amount: 0.5 },
			Operation::AdjustTint { amount: 0.3 },
		];
		let t1 = Instant::now();
		let result = apply_pipeline(&src, &ops).unwrap();
		let proc_ms = t1.elapsed().as_secs_f64() * 1000.0;
		let t2 = Instant::now();
		save_image(&result, "/tmp/garnet-repro.jpg", "jpg").unwrap();
		let jpg_ms = t2.elapsed().as_secs_f64() * 1000.0;
		save_image(&result, "/tmp/garnet-repro.png", "png8").unwrap();
		let (ir, ig, ib) = mean_rgb(&src);
		let (or, og, ob) = mean_rgb(&result);
		println!(
			"\n[repro] {sw}x{sh}  load={load_ms:.0}ms  process={proc_ms:.0}ms  save_jpg={jpg_ms:.0}ms"
		);
		println!("[repro] input  meanRGB = ({ir:.1}, {ig:.1}, {ib:.1})");
		println!("[repro] output meanRGB = ({or:.1}, {og:.1}, {ob:.1})  (warm edit ⇒ R↑ B↓ expected)");
	}

	#[test]
	#[ignore]
	fn bench_commit() {
		println!("\n=== commit-path benchmark (apply_pipeline + save) ===");
		let mut sides = vec![2048u32, 4096];
		if std::env::var("GARNET_BENCH_8K").is_ok() {
			sides.push(8192);
		}
		let ops = rep_ops();
		for side in sides {
			let mp = (side as f64 * side as f64) / 1_000_000.0;
			println!("\n-- {side}x{side} ({mp:.1} MP) --");
			let src8 = grad_rgba8(side);
			time_case(&format!("{side} src8 -> png8"), &src8, &ops, "png8");
			time_case(&format!("{side} src8 -> png16"), &src8, &ops, "png16");
			let src16 = grad_rgba16(side);
			time_case(&format!("{side} src16 -> png16"), &src16, &ops, "png16");
		}
	}
}

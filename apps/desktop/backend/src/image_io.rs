// SPDX-License-Identifier: AGPL-3.0-or-later
//! Base image I/O shared by plugins and base modules (Automations, the 3D
//! Texturing plugin's Pack/Size/Preview tools). A superset of the editor's
//! slim `editor::io` — it adds EXR (via the `exr` crate), TGA, base64 preview
//! encoding, channel extraction, image info, and directory listing.
//!
//! Ported from Packi's `image_io.rs` so the texture tools behave identically.
//! These commands return small base64 PNG previews (capped by
//! `max_preview_size`) rather than going through Garnet's temp-file + media
//! server path the editor uses; the preview payloads are small enough that the
//! base64 IPC cost is negligible. (Unifying the two conventions is a future
//! cleanup — see the editor's `io.rs`.)

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;

/// Extensions the texture tools recognize as loadable images.
const SUPPORTED_EXTS: &[&str] = &["png", "tga", "jpg", "jpeg", "tif", "tiff", "bmp", "exr"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
	pub width: u32,
	pub height: u32,
	pub channels: u32,
	pub format: String,
	pub bit_depth: u32,
	pub file_size: u64,
}

#[tauri::command]
pub async fn load_image_info(path: String) -> Result<ImageInfo, String> {
	tokio::task::spawn_blocking(move || load_image_info_sync(&path))
		.await
		.map_err(|e| format!("Task failed: {}", e))?
}

fn load_image_info_sync(path: &str) -> Result<ImageInfo, String> {
	let file_path = Path::new(path);
	let metadata =
		std::fs::metadata(file_path).map_err(|e| format!("Failed to read file metadata: {}", e))?;

	// EXR files need special handling since ImageReader doesn't support them.
	if has_ext(file_path, "exr") {
		let img = load_exr(path)?;
		let (width, height) = img.dimensions();
		return Ok(ImageInfo {
			width,
			height,
			channels: 4,
			format: "EXR".to_string(),
			bit_depth: 32,
			file_size: metadata.len(),
		});
	}

	let reader = ImageReader::open(file_path)
		.map_err(|e| format!("Failed to open image: {}", e))?
		.with_guessed_format()
		.map_err(|e| format!("Failed to detect format: {}", e))?;

	let format = reader
		.format()
		.map(format_to_string)
		.unwrap_or_else(|| "unknown".to_string());

	let img = reader
		.decode()
		.map_err(|e| format!("Failed to decode image: {}", e))?;

	let (width, height) = img.dimensions();
	let channels = img.color().channel_count() as u32;
	let bit_depth = (img.color().bytes_per_pixel() as u32 * 8) / channels;

	Ok(ImageInfo {
		width,
		height,
		channels,
		format,
		bit_depth,
		file_size: metadata.len(),
	})
}

/// Image info plus a base64 preview from a single decode pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageWithPreview {
	pub info: ImageInfo,
	pub preview: String,
}

#[tauri::command]
pub async fn load_image_with_preview(
	path: String,
	max_preview_size: Option<u32>,
) -> Result<ImageWithPreview, String> {
	tokio::task::spawn_blocking(move || {
		let file_path = Path::new(&path);
		let metadata = std::fs::metadata(file_path)
			.map_err(|e| format!("Failed to read file metadata: {}", e))?;

		// EXR needs the dedicated loader; the info comes back as 32-bit RGBA.
		if has_ext(file_path, "exr") {
			let img = load_exr(&path)?;
			let (width, height) = img.dimensions();
			let info = ImageInfo {
				width,
				height,
				channels: 4,
				format: "EXR".to_string(),
				bit_depth: 32,
				file_size: metadata.len(),
			};
			let preview = encode_to_base64_png(&maybe_resize(img, max_preview_size))?;
			return Ok(ImageWithPreview { info, preview });
		}

		let reader = ImageReader::open(file_path)
			.map_err(|e| format!("Failed to open image: {}", e))?
			.with_guessed_format()
			.map_err(|e| format!("Failed to detect format: {}", e))?;

		let format = reader
			.format()
			.map(format_to_string)
			.unwrap_or_else(|| "unknown".to_string());

		let img = reader
			.decode()
			.map_err(|e| format!("Failed to decode image: {}", e))?;

		let (width, height) = img.dimensions();
		let channels = img.color().channel_count() as u32;
		let bit_depth = (img.color().bytes_per_pixel() as u32 * 8) / channels;

		let info = ImageInfo {
			width,
			height,
			channels,
			format,
			bit_depth,
			file_size: metadata.len(),
		};

		let preview = encode_to_base64_png(&maybe_resize(img, max_preview_size))?;
		Ok(ImageWithPreview { info, preview })
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn load_image_as_base64(
	path: String,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = maybe_resize(load_dynamic_image(&path)?, max_preview_size);
		encode_to_base64_png(&img)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn load_image_channel(path: String, channel: u8) -> Result<String, String> {
	tokio::task::spawn_blocking(move || load_image_channel_sync(&path, channel))
		.await
		.map_err(|e| format!("Task failed: {}", e))?
}

fn load_image_channel_sync(path: &str, channel: u8) -> Result<String, String> {
	let img = load_dynamic_image(path)?;
	let rgba = img.to_rgba8();
	let (w, h) = rgba.dimensions();

	let mut gray = image::GrayImage::new(w, h);
	for (x, y, pixel) in rgba.enumerate_pixels() {
		let val = match channel {
			0 => pixel[0],
			1 => pixel[1],
			2 => pixel[2],
			3 => pixel[3],
			// Luminance (Rec. 709 weights) for anything else.
			_ => {
				let r = pixel[0] as f32;
				let g = pixel[1] as f32;
				let b = pixel[2] as f32;
				(0.2126 * r + 0.7152 * g + 0.0722 * b).round() as u8
			}
		};
		gray.put_pixel(x, y, image::Luma([val]));
	}

	encode_to_base64_png(&DynamicImage::ImageLuma8(gray))
}

fn has_ext(path: &Path, ext: &str) -> bool {
	path.extension()
		.and_then(|e| e.to_str())
		.is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Load a DynamicImage from a path, dispatching to the EXR loader for `.exr`.
pub fn load_dynamic_image(path: &str) -> Result<DynamicImage, String> {
	if has_ext(Path::new(path), "exr") {
		return load_exr(path);
	}

	let reader = ImageReader::open(path)
		.map_err(|e| format!("Failed to open image: {}", e))?
		.with_guessed_format()
		.map_err(|e| format!("Failed to detect format: {}", e))?;

	reader
		.decode()
		.map_err(|e| format!("Failed to decode image: {}", e))
}

/// Load an OpenEXR file as an RGBA8 DynamicImage (tone-mapped for preview).
fn load_exr(path: &str) -> Result<DynamicImage, String> {
	use exr::prelude::*;

	let image = read_first_rgba_layer_from_file(
		path,
		|resolution, _| {
			image::RgbaImage::new(resolution.width() as u32, resolution.height() as u32)
		},
		|img, position, (r, g, b, a): (f32, f32, f32, f32)| {
			// Tone-map HDR → 8-bit: simple linear clamp.
			let to_u8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
			img.put_pixel(
				position.x() as u32,
				position.y() as u32,
				image::Rgba([to_u8(r), to_u8(g), to_u8(b), to_u8(a)]),
			);
		},
	)
	.map_err(|e| format!("Failed to read EXR: {}", e))?;

	Ok(DynamicImage::ImageRgba8(image.layer_data.channel_data.pixels))
}

/// Save a DynamicImage as OpenEXR (RGBA float32).
fn save_exr(img: &DynamicImage, path: &str) -> Result<(), String> {
	use exr::prelude::*;

	let rgba = img.to_rgba8();
	let (w, h) = rgba.dimensions();

	let channels = SpecificChannels::rgba(|position: Vec2<usize>| {
		let pixel = rgba.get_pixel(position.x() as u32, position.y() as u32);
		(
			pixel[0] as f32 / 255.0,
			pixel[1] as f32 / 255.0,
			pixel[2] as f32 / 255.0,
			pixel[3] as f32 / 255.0,
		)
	});

	let layer = Layer::new(
		(w as usize, h as usize),
		LayerAttributes::named("rgba"),
		Encoding::SMALL_LOSSLESS,
		channels,
	);

	Image::from_layer(layer)
		.write()
		.to_file(path)
		.map_err(|e| format!("Failed to write EXR: {}", e))?;

	Ok(())
}

/// Encode a DynamicImage to a base64 PNG string using fast compression.
pub fn encode_to_base64_png(img: &DynamicImage) -> Result<String, String> {
	use base64::Engine;

	let mut buf = Vec::new();
	let cursor = Cursor::new(&mut buf);
	let encoder = PngEncoder::new_with_quality(cursor, CompressionType::Fast, FilterType::Sub);
	img.write_with_encoder(encoder)
		.map_err(|e| format!("Failed to encode PNG: {}", e))?;

	Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

/// Optionally downscale an image to fit within `max_size` on its longest axis.
pub fn maybe_resize(img: DynamicImage, max_size: Option<u32>) -> DynamicImage {
	if let Some(max_size) = max_size {
		let (w, h) = img.dimensions();
		if w > max_size || h > max_size {
			return img.resize(max_size, max_size, image::imageops::FilterType::CatmullRom);
		}
	}
	img
}

/// Save a DynamicImage to a path and format. Format string carries bit-depth
/// intent: "png8" (8-bit), "png16" (16-bit). Supports png/tga/jpg/exr.
pub fn save_image(img: &DynamicImage, path: &str, format: &str) -> Result<(), String> {
	let output_path = Path::new(path);

	match format {
		"png" | "png8" => img
			.to_rgba8()
			.save(output_path)
			.map_err(|e| format!("Failed to save PNG: {}", e))?,
		"png16" => img
			.to_rgba16()
			.save(output_path)
			.map_err(|e| format!("Failed to save PNG 16-bit: {}", e))?,
		"tga" => DynamicImage::ImageRgba8(img.to_rgba8())
			.save_with_format(output_path, ImageFormat::Tga)
			.map_err(|e| format!("Failed to save TGA: {}", e))?,
		"jpg" | "jpeg" => img
			.to_rgb8()
			.save(output_path)
			.map_err(|e| format!("Failed to save JPEG: {}", e))?,
		"exr" => save_exr(img, path)?,
		"webp" => DynamicImage::ImageRgba8(img.to_rgba8())
			.save_with_format(output_path, ImageFormat::WebP)
			.map_err(|e| format!("Failed to save WebP: {}", e))?,
		"bmp" => img
			.to_rgb8()
			.save(output_path)
			.map_err(|e| format!("Failed to save BMP: {}", e))?,
		"tiff" | "tif" => DynamicImage::ImageRgba8(img.to_rgba8())
			.save_with_format(output_path, ImageFormat::Tiff)
			.map_err(|e| format!("Failed to save TIFF: {}", e))?,
		"gif" => DynamicImage::ImageRgba8(img.to_rgba8())
			.save_with_format(output_path, ImageFormat::Gif)
			.map_err(|e| format!("Failed to save GIF: {}", e))?,
		_ => return Err(format!("Unsupported export format: {}", format)),
	}

	Ok(())
}

/// Decode base64 PNG data and save it to a path in the requested format. Used
/// for exporting viewport screenshots (2D tiling / 3D material previews).
#[tauri::command]
pub async fn save_viewport(
	data: String,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		use base64::Engine;
		let bytes = base64::engine::general_purpose::STANDARD
			.decode(&data)
			.map_err(|e| format!("Invalid base64: {}", e))?;
		let img = image::load_from_memory(&bytes)
			.map_err(|e| format!("Failed to decode image: {}", e))?;
		save_image(&img, &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
	pub name: String,
	pub path: String,
	pub is_dir: bool,
}

/// List a directory's immediate children: subdirectories + supported images.
#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
	let dir_path = Path::new(&path);
	if !dir_path.is_dir() {
		return Err(format!("Not a directory: {}", path));
	}

	let mut entries = Vec::new();
	for entry in
		std::fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?
	{
		let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
		let entry_path = entry.path();
		let name = entry.file_name().to_string_lossy().to_string();

		if name.starts_with('.') {
			continue;
		}

		if entry_path.is_dir() {
			entries.push(DirEntry {
				name,
				path: entry_path.to_string_lossy().to_string(),
				is_dir: true,
			});
		} else if let Some(ext) = entry_path.extension().and_then(|s| s.to_str()) {
			if SUPPORTED_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
				entries.push(DirEntry {
					name,
					path: entry_path.to_string_lossy().to_string(),
					is_dir: false,
				});
			}
		}
	}

	entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
		(true, false) => std::cmp::Ordering::Less,
		(false, true) => std::cmp::Ordering::Greater,
		_ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
	});

	Ok(entries)
}

/// List supported image file paths in a directory, optionally recursing.
#[tauri::command]
pub fn list_image_files(dir: String, recursive: Option<bool>) -> Result<Vec<String>, String> {
	let path = Path::new(&dir);
	if !path.is_dir() {
		return Err(format!("Not a directory: {}", dir));
	}

	let mut files = Vec::new();
	collect_image_files(path, recursive.unwrap_or(false), &mut files)?;
	files.sort();
	Ok(files)
}

fn collect_image_files(dir: &Path, recursive: bool, results: &mut Vec<String>) -> Result<(), String> {
	let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
	for entry in entries {
		let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
		let path = entry.path();
		if path.is_dir() {
			if recursive {
				collect_image_files(&path, true, results)?;
			}
		} else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
			if SUPPORTED_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
				if let Some(p) = path.to_str() {
					results.push(p.to_string());
				}
			}
		}
	}
	Ok(())
}

fn format_to_string(format: ImageFormat) -> String {
	match format {
		ImageFormat::Png => "PNG".to_string(),
		ImageFormat::Jpeg => "JPEG".to_string(),
		ImageFormat::Tga => "TGA".to_string(),
		ImageFormat::Tiff => "TIFF".to_string(),
		ImageFormat::Bmp => "BMP".to_string(),
		ImageFormat::WebP => "WEBP".to_string(),
		ImageFormat::Gif => "GIF".to_string(),
		_ => format!("{:?}", format),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_test_image(w: u32, h: u32) -> DynamicImage {
		let mut img = image::RgbaImage::new(w, h);
		for y in 0..h {
			for x in 0..w {
				let r = ((x * 64) % 256) as u8;
				let g = ((y * 64) % 256) as u8;
				let b = (((x + y) * 32) % 256) as u8;
				img.put_pixel(x, y, image::Rgba([r, g, b, 255]));
			}
		}
		DynamicImage::ImageRgba8(img)
	}

	#[test]
	fn encode_base64_produces_valid_png() {
		use base64::Engine;
		let b64 = encode_to_base64_png(&make_test_image(4, 4)).unwrap();
		let bytes = base64::engine::general_purpose::STANDARD.decode(&b64).unwrap();
		assert_eq!(&bytes[0..4], &[0x89, 0x50, 0x4E, 0x47]);
		assert_eq!(image::load_from_memory(&bytes).unwrap().dimensions(), (4, 4));
	}

	#[test]
	fn maybe_resize_behaviors() {
		assert_eq!(maybe_resize(make_test_image(100, 100), None).dimensions(), (100, 100));
		assert_eq!(maybe_resize(make_test_image(50, 50), Some(100)).dimensions(), (50, 50));
		// 200×100 scaled to fit 100×100 → 100×50 (aspect preserved).
		assert_eq!(maybe_resize(make_test_image(200, 100), Some(100)).dimensions(), (100, 50));
	}

	#[test]
	fn roundtrip_png_tga_jpeg() {
		let tmp = tempfile::tempdir().unwrap();
		for (file, fmt) in [("a.png", "png8"), ("b.tga", "tga"), ("c.jpg", "jpeg")] {
			let path = tmp.path().join(file);
			let p = path.to_str().unwrap();
			save_image(&make_test_image(8, 8), p, fmt).unwrap();
			assert_eq!(load_dynamic_image(p).unwrap().dimensions(), (8, 8));
		}
	}

	#[test]
	fn save_unsupported_format_errors() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("x.xyz");
		assert!(save_image(&make_test_image(4, 4), path.to_str().unwrap(), "xyz").is_err());
	}

	#[test]
	fn load_channel_red_and_luminance() {
		use base64::Engine;
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("c.png");
		let mut img = image::RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([100, 150, 200, 255]));
		img.save(&path).unwrap();
		let p = path.to_str().unwrap();

		let red = load_image_channel_sync(p, 0).unwrap();
		let bytes = base64::engine::general_purpose::STANDARD.decode(&red).unwrap();
		assert_eq!(image::load_from_memory(&bytes).unwrap().to_luma8().get_pixel(0, 0)[0], 100);

		let lum = load_image_channel_sync(p, 255).unwrap();
		let bytes = base64::engine::general_purpose::STANDARD.decode(&lum).unwrap();
		let val = image::load_from_memory(&bytes).unwrap().to_luma8().get_pixel(0, 0)[0];
		// 0.2126*100 + 0.7152*150 + 0.0722*200 ≈ 144
		assert!((val as i16 - 144).abs() <= 1);
	}

	#[test]
	fn info_returns_dimensions_and_format() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("info.png");
		image::RgbaImage::new(32, 16).save(&path).unwrap();
		let info = load_image_info_sync(path.to_str().unwrap()).unwrap();
		assert_eq!((info.width, info.height), (32, 16));
		assert_eq!(info.format, "PNG");
		assert!(info.file_size > 0);
	}

	#[test]
	fn roundtrip_exr() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("t.exr");
		let p = path.to_str().unwrap();
		let img = make_test_image(8, 8);
		save_image(&img, p, "exr").unwrap();

		let loaded = load_dynamic_image(p).unwrap();
		assert_eq!(loaded.dimensions(), (8, 8));
		// EXR round-trips through f32; allow ±1 per channel.
		let (orig, back) = (img.to_rgba8(), loaded.to_rgba8());
		for (x, y, o) in orig.enumerate_pixels() {
			let b = back.get_pixel(x, y);
			for ch in 0..4 {
				assert!((o[ch] as i16 - b[ch] as i16).abs() <= 1);
			}
		}

		let info = load_image_info_sync(p).unwrap();
		assert_eq!((info.format.as_str(), info.bit_depth), ("EXR", 32));
	}

	#[test]
	fn list_image_files_filters_and_sorts() {
		let tmp = tempfile::tempdir().unwrap();
		image::RgbaImage::new(2, 2).save(tmp.path().join("b.png")).unwrap();
		image::RgbaImage::new(2, 2).save(tmp.path().join("a.png")).unwrap();
		std::fs::write(tmp.path().join("notes.txt"), b"x").unwrap();
		let files = list_image_files(tmp.path().to_string_lossy().to_string(), Some(false)).unwrap();
		assert_eq!(files.len(), 2);
		assert!(files[0].ends_with("a.png") && files[1].ends_with("b.png"));
	}
}

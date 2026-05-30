// SPDX-License-Identifier: AGPL-3.0-or-later
//! Channel packing, unpacking, and swizzling for the 3D Texturing plugin.
//! Ported from Packi's channel_pack.rs. Channel index convention: 0=R, 1=G,
//! 2=B, 3=A, 4=Luminance. Preview commands return base64 PNG; export commands
//! write files.

use image::{DynamicImage, GenericImageView, RgbaImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::image_io::{encode_to_base64_png, load_dynamic_image, maybe_resize, save_image};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSourceConfig {
	pub path: String,
	/// Source channel index: 0=R, 1=G, 2=B, 3=A, 4=Luminance.
	pub source_channel: u8,
	pub invert: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackConfig {
	pub r: Option<ChannelSourceConfig>,
	pub g: Option<ChannelSourceConfig>,
	pub b: Option<ChannelSourceConfig>,
	pub a: Option<ChannelSourceConfig>,
	pub target_resolution: Option<(u32, u32)>,
}

/// Pack channels from multiple source images into one RGBA image; returns a
/// base64 PNG preview downsampled to `max_preview_size` if provided.
#[tauri::command]
pub async fn pack_channels(
	config: PackConfig,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let packed = do_pack(&config)?;
		let preview = maybe_resize(DynamicImage::ImageRgba8(packed), max_preview_size);
		encode_to_base64_png(&preview)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

/// Pack channels and export to disk.
#[tauri::command]
pub async fn export_packed(
	config: PackConfig,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let packed = do_pack(&config)?;
		save_image(&DynamicImage::ImageRgba8(packed), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

fn do_pack(config: &PackConfig) -> Result<RgbaImage, String> {
	let (target_w, target_h) = if let Some(res) = config.target_resolution {
		res
	} else {
		find_max_resolution(config)?
	};

	if target_w == 0 || target_h == 0 {
		return Err("No source images provided".to_string());
	}

	let channels: [Option<&ChannelSourceConfig>; 4] = [
		config.r.as_ref(),
		config.g.as_ref(),
		config.b.as_ref(),
		config.a.as_ref(),
	];

	let channel_data: Vec<Option<Vec<u8>>> = channels
		.par_iter()
		.map(|ch_config| {
			ch_config
				.map(|cfg| extract_channel(cfg, target_w, target_h))
				.transpose()
		})
		.collect::<Result<Vec<_>, _>>()?;

	let mut packed = RgbaImage::new(target_w, target_h);
	let pixel_count = (target_w * target_h) as usize;

	for i in 0..pixel_count {
		let r = channel_data[0].as_ref().map_or(0u8, |d| d[i]);
		let g = channel_data[1].as_ref().map_or(0u8, |d| d[i]);
		let b = channel_data[2].as_ref().map_or(0u8, |d| d[i]);
		let a = channel_data[3].as_ref().map_or(255u8, |d| d[i]);
		packed.put_pixel(
			(i as u32) % target_w,
			(i as u32) / target_w,
			image::Rgba([r, g, b, a]),
		);
	}

	Ok(packed)
}

/// Extract a single channel from a source image as a flat Vec<u8>.
fn extract_channel(
	config: &ChannelSourceConfig,
	target_w: u32,
	target_h: u32,
) -> Result<Vec<u8>, String> {
	let img = load_dynamic_image(&config.path)?;
	let img = {
		let (w, h) = img.dimensions();
		if w != target_w || h != target_h {
			img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3)
		} else {
			img
		}
	};

	let rgba = img.to_rgba8();
	let mut data = Vec::with_capacity((target_w * target_h) as usize);

	for pixel in rgba.pixels() {
		let val = sample_channel(pixel, config.source_channel);
		data.push(if config.invert { 255 - val } else { val });
	}

	Ok(data)
}

/// Sample a channel value (0=R..3=A, anything else = Rec.709 luminance).
fn sample_channel(pixel: &image::Rgba<u8>, channel: u8) -> u8 {
	match channel {
		0 => pixel[0],
		1 => pixel[1],
		2 => pixel[2],
		3 => pixel[3],
		_ => {
			let r = pixel[0] as f32;
			let g = pixel[1] as f32;
			let b = pixel[2] as f32;
			(0.2126 * r + 0.7152 * g + 0.0722 * b).round() as u8
		}
	}
}

// --- Unpack ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnpackResult {
	pub r: String,
	pub g: String,
	pub b: String,
	pub a: String,
}

/// Extract all 4 RGBA channels from a packed image as grayscale previews.
#[tauri::command]
pub async fn unpack_channels(
	path: String,
	max_preview_size: Option<u32>,
) -> Result<UnpackResult, String> {
	tokio::task::spawn_blocking(move || {
		let img = maybe_resize(load_dynamic_image(&path)?, max_preview_size);
		let rgba = img.to_rgba8();
		let (w, h) = rgba.dimensions();

		let channels: Vec<String> = (0u8..4)
			.into_par_iter()
			.map(|ch_idx| {
				let mut gray = image::GrayImage::new(w, h);
				for (x, y, pixel) in rgba.enumerate_pixels() {
					gray.put_pixel(x, y, image::Luma([pixel[ch_idx as usize]]));
				}
				encode_to_base64_png(&DynamicImage::ImageLuma8(gray))
			})
			.collect::<Result<Vec<_>, _>>()?;

		Ok(UnpackResult {
			r: channels[0].clone(),
			g: channels[1].clone(),
			b: channels[2].clone(),
			a: channels[3].clone(),
		})
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

/// Export a single channel from a packed image as a grayscale file.
#[tauri::command]
pub async fn export_unpacked(
	path: String,
	channel: u8,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let rgba = load_dynamic_image(&path)?.to_rgba8();
		let (w, h) = rgba.dimensions();
		let mut gray = image::GrayImage::new(w, h);
		for (x, y, pixel) in rgba.enumerate_pixels() {
			gray.put_pixel(x, y, image::Luma([sample_channel(pixel, channel)]));
		}
		save_image(&DynamicImage::ImageLuma8(gray), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

// --- Swizzle ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwizzleConfig {
	pub r_source: u8,
	pub g_source: u8,
	pub b_source: u8,
	pub a_source: u8,
	pub r_invert: bool,
	pub g_invert: bool,
	pub b_invert: bool,
	pub a_invert: bool,
}

fn read_source(pixel: &image::Rgba<u8>, source: u8, invert: bool) -> u8 {
	let val = sample_channel(pixel, source);
	if invert {
		255 - val
	} else {
		val
	}
}

fn do_swizzle(img: &DynamicImage, config: &SwizzleConfig) -> RgbaImage {
	let rgba = img.to_rgba8();
	let (w, h) = rgba.dimensions();
	let mut out = RgbaImage::new(w, h);
	for (x, y, pixel) in rgba.enumerate_pixels() {
		out.put_pixel(
			x,
			y,
			image::Rgba([
				read_source(pixel, config.r_source, config.r_invert),
				read_source(pixel, config.g_source, config.g_invert),
				read_source(pixel, config.b_source, config.b_invert),
				read_source(pixel, config.a_source, config.a_invert),
			]),
		);
	}
	out
}

/// Remap channels within a single image according to a swizzle config.
#[tauri::command]
pub async fn swizzle_channels(
	path: String,
	config: SwizzleConfig,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = maybe_resize(load_dynamic_image(&path)?, max_preview_size);
		let result = do_swizzle(&img, &config);
		encode_to_base64_png(&DynamicImage::ImageRgba8(result))
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

/// Export a swizzled image to disk.
#[tauri::command]
pub async fn export_swizzled(
	path: String,
	config: SwizzleConfig,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let img = load_dynamic_image(&path)?;
		let result = do_swizzle(&img, &config);
		save_image(&DynamicImage::ImageRgba8(result), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

/// Find the maximum resolution among the source images (header read only).
fn find_max_resolution(config: &PackConfig) -> Result<(u32, u32), String> {
	let mut max_w = 0u32;
	let mut max_h = 0u32;
	for cfg in [&config.r, &config.g, &config.b, &config.a]
		.into_iter()
		.flatten()
	{
		let (w, h) = image::image_dimensions(&cfg.path)
			.map_err(|e| format!("Failed to read image dimensions for {}: {}", cfg.path, e))?;
		max_w = max_w.max(w);
		max_h = max_h.max(h);
	}
	Ok((max_w, max_h))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sample_channel_and_invert() {
		let pixel = image::Rgba([10, 20, 30, 40]);
		assert_eq!(sample_channel(&pixel, 0), 10);
		assert_eq!(sample_channel(&pixel, 3), 40);
		// Luminance of [100,150,200] ≈ 144
		assert!((sample_channel(&image::Rgba([100, 150, 200, 255]), 4) as i16 - 144).abs() <= 1);
		assert_eq!(read_source(&image::Rgba([100, 0, 255, 128]), 0, true), 155);
	}

	#[test]
	fn swizzle_remap_and_invert() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([10, 20, 30, 40]));
		// R←B, G←A, B←R, A←G
		let cfg = SwizzleConfig {
			r_source: 2,
			g_source: 3,
			b_source: 0,
			a_source: 1,
			r_invert: false,
			g_invert: false,
			b_invert: false,
			a_invert: false,
		};
		let result = do_swizzle(&DynamicImage::ImageRgba8(img), &cfg);
		assert_eq!(*result.get_pixel(0, 0), image::Rgba([30, 40, 10, 20]));
	}

	#[test]
	fn pack_single_channel_with_invert() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("src.png");
		let mut img = RgbaImage::new(2, 2);
		for pixel in img.pixels_mut() {
			*pixel = image::Rgba([100, 100, 100, 255]);
		}
		img.save(&path).unwrap();

		let cfg = PackConfig {
			r: Some(ChannelSourceConfig {
				path: path.to_str().unwrap().to_string(),
				source_channel: 0,
				invert: true,
			}),
			g: None,
			b: None,
			a: None,
			target_resolution: Some((2, 2)),
		};
		let result = do_pack(&cfg).unwrap();
		let p = result.get_pixel(0, 0);
		assert_eq!(p[0], 155); // inverted 100
		assert_eq!(p[3], 255); // alpha default
	}

	#[test]
	fn pack_no_sources_errors() {
		let cfg = PackConfig {
			r: None,
			g: None,
			b: None,
			a: None,
			target_resolution: None,
		};
		assert!(do_pack(&cfg).is_err());
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Channel packing, unpacking, and swizzling for the 3D Texturing plugin.
//! Ported from Packi's channel_pack.rs. Channel index convention: 0=R, 1=G,
//! 2=B, 3=A, 4=Luminance. Preview commands return base64 PNG; export commands
//! write files.
//!
//! Works on a normalized `Rgba32FImage` (channel values 0..1) so packing a
//! higher-bit source channel (e.g. a 16-bit height/AO map) and exporting
//! `png16` preserves real precision rather than truncating to 8-bit.
//! Quantization to the chosen output depth happens in `save_image`; previews
//! collapse to 8-bit at encode time.

use image::{DynamicImage, Rgba, Rgba32FImage};
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
		let preview = maybe_resize(DynamicImage::ImageRgba32F(packed), max_preview_size);
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
		save_image(&DynamicImage::ImageRgba32F(packed), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

fn do_pack(config: &PackConfig) -> Result<Rgba32FImage, String> {
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

	let channel_data: Vec<Option<Vec<f32>>> = channels
		.par_iter()
		.map(|ch_config| {
			ch_config
				.map(|cfg| extract_channel(cfg, target_w, target_h))
				.transpose()
		})
		.collect::<Result<Vec<_>, _>>()?;

	let mut packed = Rgba32FImage::new(target_w, target_h);
	let pixel_count = (target_w * target_h) as usize;

	for i in 0..pixel_count {
		let r = channel_data[0].as_ref().map_or(0.0, |d| d[i]);
		let g = channel_data[1].as_ref().map_or(0.0, |d| d[i]);
		let b = channel_data[2].as_ref().map_or(0.0, |d| d[i]);
		let a = channel_data[3].as_ref().map_or(1.0, |d| d[i]);
		packed.put_pixel(
			(i as u32) % target_w,
			(i as u32) / target_w,
			Rgba([r, g, b, a]),
		);
	}

	Ok(packed)
}

/// Extract a single channel from a source image as a flat `Vec<f32>` (0..1).
fn extract_channel(
	config: &ChannelSourceConfig,
	target_w: u32,
	target_h: u32,
) -> Result<Vec<f32>, String> {
	let buf = load_dynamic_image(&config.path)?.to_rgba32f();
	let buf = if buf.width() != target_w || buf.height() != target_h {
		image::imageops::resize(
			&buf,
			target_w,
			target_h,
			image::imageops::FilterType::Lanczos3,
		)
	} else {
		buf
	};

	let mut data = Vec::with_capacity((target_w * target_h) as usize);
	for pixel in buf.pixels() {
		let val = sample_channel(pixel, config.source_channel);
		data.push(if config.invert { 1.0 - val } else { val });
	}

	Ok(data)
}

/// Sample a channel value (0=R..3=A, anything else = Rec.709 luminance).
fn sample_channel(pixel: &Rgba<f32>, channel: u8) -> f32 {
	match channel {
		0 => pixel[0],
		1 => pixel[1],
		2 => pixel[2],
		3 => pixel[3],
		_ => 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2],
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
		let buf = maybe_resize(load_dynamic_image(&path)?, max_preview_size).to_rgba32f();
		let (w, h) = buf.dimensions();

		let channels: Vec<String> = (0u8..4)
			.into_par_iter()
			.map(|ch_idx| {
				// 8-bit grayscale is sufficient for the on-screen channel preview.
				let mut gray = image::GrayImage::new(w, h);
				for (x, y, pixel) in buf.enumerate_pixels() {
					gray.put_pixel(x, y, image::Luma([f32_to_u8(pixel[ch_idx as usize])]));
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

/// Export a single channel from a packed image as a grayscale file. Carried as
/// replicated RGB(+opaque alpha) f32 so `save_image` can emit real high-bit
/// output (`save_image` quantizes to the requested depth).
#[tauri::command]
pub async fn export_unpacked(
	path: String,
	channel: u8,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let buf = load_dynamic_image(&path)?.to_rgba32f();
		let (w, h) = buf.dimensions();
		let mut out = Rgba32FImage::new(w, h);
		for (x, y, pixel) in buf.enumerate_pixels() {
			let v = sample_channel(pixel, channel);
			out.put_pixel(x, y, Rgba([v, v, v, 1.0]));
		}
		save_image(&DynamicImage::ImageRgba32F(out), &output_path, &format)
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

fn read_source(pixel: &Rgba<f32>, source: u8, invert: bool) -> f32 {
	let val = sample_channel(pixel, source);
	if invert {
		1.0 - val
	} else {
		val
	}
}

fn do_swizzle(img: &DynamicImage, config: &SwizzleConfig) -> Rgba32FImage {
	let buf = img.to_rgba32f();
	let (w, h) = buf.dimensions();
	let mut out = Rgba32FImage::new(w, h);
	for (x, y, pixel) in buf.enumerate_pixels() {
		out.put_pixel(
			x,
			y,
			Rgba([
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
		encode_to_base64_png(&DynamicImage::ImageRgba32F(result))
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
		save_image(&DynamicImage::ImageRgba32F(result), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

/// Quantize a normalized f32 channel value to 8-bit for previews.
fn f32_to_u8(v: f32) -> u8 {
	(v.clamp(0.0, 1.0) * 255.0).round() as u8
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
	use image::RgbaImage;

	const EPS: f32 = 1.5 / 255.0;

	fn close(a: f32, b: f32) -> bool {
		(a - b).abs() <= EPS
	}

	#[test]
	fn sample_channel_and_invert() {
		// Values in normalized 0..1 space.
		let pixel = Rgba([10.0 / 255.0, 20.0 / 255.0, 30.0 / 255.0, 40.0 / 255.0]);
		assert!(close(sample_channel(&pixel, 0), 10.0 / 255.0));
		assert!(close(sample_channel(&pixel, 3), 40.0 / 255.0));
		// Luminance of [100,150,200] ≈ 143
		let lum = sample_channel(&Rgba([100.0 / 255.0, 150.0 / 255.0, 200.0 / 255.0, 1.0]), 4);
		assert!(close(lum, 143.0 / 255.0));
		// Inverted red of 100/255 → 155/255.
		let inv = read_source(&Rgba([100.0 / 255.0, 0.0, 1.0, 0.5]), 0, true);
		assert!(close(inv, 155.0 / 255.0));
	}

	#[test]
	fn swizzle_remap_and_invert() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([10, 20, 30, 40]));
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
		let p = DynamicImage::ImageRgba32F(result).to_rgba8();
		assert_eq!(*p.get_pixel(0, 0), Rgba([30, 40, 10, 20]));
	}

	#[test]
	fn pack_single_channel_with_invert() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("src.png");
		let mut img = RgbaImage::new(2, 2);
		for pixel in img.pixels_mut() {
			*pixel = Rgba([100, 100, 100, 255]);
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
		let result = DynamicImage::ImageRgba32F(do_pack(&cfg).unwrap()).to_rgba8();
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

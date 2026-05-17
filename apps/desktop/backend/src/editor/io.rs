// SPDX-License-Identifier: AGPL-3.0-or-later
//! Image I/O helpers shared across editor tools. Slim subset of Packi's
//! `image_io.rs` — Garnet doesn't pull in `exr`, so EXR is intentionally
//! absent here. Add it to `Cargo.toml`'s `image` features (and re-add the
//! EXR branches) if the editor ever needs to round-trip HDR.

use image::{DynamicImage, ImageFormat, ImageReader};
use std::path::Path;

/// Load a DynamicImage from a file path.
pub fn load_dynamic_image(path: &str) -> Result<DynamicImage, String> {
	let reader = ImageReader::open(path)
		.map_err(|e| format!("Failed to open image: {}", e))?
		.with_guessed_format()
		.map_err(|e| format!("Failed to detect format: {}", e))?;
	reader
		.decode()
		.map_err(|e| format!("Failed to decode image: {}", e))
}

/// Optionally downscale an image to fit within `max_size` on its longest axis.
/// Used to keep preview round-trips cheap during slider drags.
pub fn maybe_resize(img: DynamicImage, max_size: Option<u32>) -> DynamicImage {
	if let Some(max) = max_size {
		let (w, h) = (img.width(), img.height());
		if w > max || h > max {
			return img.resize(max, max, image::imageops::FilterType::CatmullRom);
		}
	}
	img
}

/// Save a DynamicImage to disk. Format string is lowercased extension-ish
/// ("png", "png16", "tga", "jpg"/"jpeg", "webp", "bmp", "tiff"). Formats
/// that don't carry alpha (jpg, bmp) silently flatten the image.
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
		"jpg" | "jpeg" => img
			.to_rgb8()
			.save(output_path)
			.map_err(|e| format!("Failed to save JPEG: {}", e))?,
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
		other => return Err(format!("Unsupported export format: {}", other)),
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::GenericImageView;

	fn solid(w: u32, h: u32, color: [u8; 4]) -> DynamicImage {
		let mut img = image::RgbaImage::new(w, h);
		for p in img.pixels_mut() {
			*p = image::Rgba(color);
		}
		DynamicImage::ImageRgba8(img)
	}

	#[test]
	fn roundtrip_png() {
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("x.png");
		let img = solid(4, 4, [200, 100, 50, 255]);
		save_image(&img, path.to_str().unwrap(), "png").unwrap();
		let loaded = load_dynamic_image(path.to_str().unwrap()).unwrap();
		assert_eq!(loaded.dimensions(), (4, 4));
	}

	#[test]
	fn maybe_resize_downscales_when_over() {
		let img = solid(200, 100, [0, 0, 0, 255]);
		let r = maybe_resize(img, Some(50));
		assert!(r.width() <= 50 && r.height() <= 50);
	}

	#[test]
	fn maybe_resize_passthrough_under_limit() {
		let img = solid(40, 40, [0, 0, 0, 255]);
		let r = maybe_resize(img, Some(100));
		assert_eq!(r.dimensions(), (40, 40));
	}

}

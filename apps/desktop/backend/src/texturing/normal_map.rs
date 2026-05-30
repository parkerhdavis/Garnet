// SPDX-License-Identifier: AGPL-3.0-or-later
//! Normal-map operations for the 3D Texturing plugin: flip-green (DX↔GL),
//! height-to-normal (Sobel), blend (Reoriented Normal Mapping), and re-
//! normalize. The pure `*_on_image` functions are reused by the Automations
//! module's FlipGreen / Normalize steps. Ported from Packi's normal_map.rs.

use image::{DynamicImage, RgbaImage};

use crate::image_io::{encode_to_base64_png, load_dynamic_image, maybe_resize, save_image};

// --- Pure in-memory image-processing functions ---

/// Flip the green channel of an RGBA image (DX ↔ OpenGL convention swap).
pub fn flip_green_on_image(mut rgba: RgbaImage) -> RgbaImage {
	for pixel in rgba.pixels_mut() {
		pixel[1] = 255 - pixel[1];
	}
	rgba
}

/// Generate a normal map from an RGBA heightmap via Sobel filtering.
pub fn height_to_normal_on_image(rgba: &RgbaImage, strength: f32) -> RgbaImage {
	let gray = image::DynamicImage::ImageRgba8(rgba.clone()).to_luma8();
	let (w, h) = gray.dimensions();
	let mut normal = RgbaImage::new(w, h);

	for y in 0..h {
		for x in 0..w {
			let sample = |sx: i32, sy: i32| -> f32 {
				let cx = sx.clamp(0, w as i32 - 1) as u32;
				let cy = sy.clamp(0, h as i32 - 1) as u32;
				gray.get_pixel(cx, cy)[0] as f32 / 255.0
			};

			let ix = x as i32;
			let iy = y as i32;

			let dx = -sample(ix - 1, iy - 1) - 2.0 * sample(ix - 1, iy) - sample(ix - 1, iy + 1)
				+ sample(ix + 1, iy - 1)
				+ 2.0 * sample(ix + 1, iy)
				+ sample(ix + 1, iy + 1);

			let dy = -sample(ix - 1, iy - 1) - 2.0 * sample(ix, iy - 1) - sample(ix + 1, iy - 1)
				+ sample(ix - 1, iy + 1)
				+ 2.0 * sample(ix, iy + 1)
				+ sample(ix + 1, iy + 1);

			let nx = -dx * strength;
			let ny = -dy * strength;
			let nz = 1.0f32;

			let len = (nx * nx + ny * ny + nz * nz).sqrt();
			let nx = nx / len;
			let ny = ny / len;
			let nz = nz / len;

			let r = ((nx * 0.5 + 0.5) * 255.0).round() as u8;
			let g = ((ny * 0.5 + 0.5) * 255.0).round() as u8;
			let b = ((nz * 0.5 + 0.5) * 255.0).round() as u8;

			normal.put_pixel(x, y, image::Rgba([r, g, b, 255]));
		}
	}

	normal
}

/// Blend two RGBA normal maps using Reoriented Normal Mapping (RNM). `rgba_b`
/// is resized to match `rgba_a` if dimensions differ.
pub fn blend_normals_on_image(
	rgba_a: &RgbaImage,
	rgba_b: &RgbaImage,
	blend_factor: f32,
) -> RgbaImage {
	let (w, h) = rgba_a.dimensions();

	let resized;
	let rgba_b = if rgba_b.dimensions() != (w, h) {
		resized = image::DynamicImage::ImageRgba8(rgba_b.clone())
			.resize_exact(w, h, image::imageops::FilterType::Lanczos3)
			.to_rgba8();
		&resized
	} else {
		rgba_b
	};

	let mut result = RgbaImage::new(w, h);

	for y in 0..h {
		for x in 0..w {
			let pa = rgba_a.get_pixel(x, y);
			let pb = rgba_b.get_pixel(x, y);

			let a = [
				pa[0] as f32 / 255.0 * 2.0 - 1.0,
				pa[1] as f32 / 255.0 * 2.0 - 1.0,
				pa[2] as f32 / 255.0 * 2.0 - 1.0,
			];
			let b = [
				pb[0] as f32 / 255.0 * 2.0 - 1.0,
				pb[1] as f32 / 255.0 * 2.0 - 1.0,
				pb[2] as f32 / 255.0 * 2.0 - 1.0,
			];

			let b = [
				b[0] * blend_factor,
				b[1] * blend_factor,
				b[2] * blend_factor + (1.0 - blend_factor),
			];

			let t = [a[0], a[1], a[2] + 1.0];
			let u = [-b[0], -b[1], b[2]];

			let dot = t[0] * u[0] + t[1] * u[1] + t[2] * u[2];
			let r = if t[2].abs() > 1e-6 {
				[
					t[0] * dot / t[2] - u[0],
					t[1] * dot / t[2] - u[1],
					t[2] * dot / t[2] - u[2],
				]
			} else {
				a
			};

			let len = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
			let r = if len > 1e-6 {
				[r[0] / len, r[1] / len, r[2] / len]
			} else {
				[0.0, 0.0, 1.0]
			};

			let out_r = ((r[0] * 0.5 + 0.5) * 255.0).round() as u8;
			let out_g = ((r[1] * 0.5 + 0.5) * 255.0).round() as u8;
			let out_b = ((r[2] * 0.5 + 0.5) * 255.0).round() as u8;

			result.put_pixel(x, y, image::Rgba([out_r, out_g, out_b, 255]));
		}
	}

	result
}

/// Re-normalize vectors to unit length in an RGBA normal map.
pub fn normalize_on_image(mut rgba: RgbaImage) -> RgbaImage {
	for pixel in rgba.pixels_mut() {
		let mut n = [
			pixel[0] as f32 / 255.0 * 2.0 - 1.0,
			pixel[1] as f32 / 255.0 * 2.0 - 1.0,
			pixel[2] as f32 / 255.0 * 2.0 - 1.0,
		];

		let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
		if len > 1e-6 {
			n[0] /= len;
			n[1] /= len;
			n[2] /= len;
		}

		pixel[0] = ((n[0] * 0.5 + 0.5) * 255.0).round() as u8;
		pixel[1] = ((n[1] * 0.5 + 0.5) * 255.0).round() as u8;
		pixel[2] = ((n[2] * 0.5 + 0.5) * 255.0).round() as u8;
	}

	rgba
}

// --- Tauri commands (thin wrappers returning base64 PNG previews) ---

#[tauri::command]
pub async fn flip_normal_green(
	path: String,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = maybe_resize(load_dynamic_image(&path)?, max_preview_size);
		let rgba = flip_green_on_image(img.to_rgba8());
		encode_to_base64_png(&DynamicImage::ImageRgba8(rgba))
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn height_to_normal(
	path: String,
	strength: f32,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = maybe_resize(load_dynamic_image(&path)?, max_preview_size);
		let result = height_to_normal_on_image(&img.to_rgba8(), strength);
		encode_to_base64_png(&DynamicImage::ImageRgba8(result))
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn blend_normals(
	path_a: String,
	path_b: String,
	blend_factor: f32,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img_a = maybe_resize(load_dynamic_image(&path_a)?, max_preview_size);
		let img_b = load_dynamic_image(&path_b)?;
		let result = blend_normals_on_image(&img_a.to_rgba8(), &img_b.to_rgba8(), blend_factor);
		encode_to_base64_png(&DynamicImage::ImageRgba8(result))
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn normalize_map(
	path: String,
	max_preview_size: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || {
		let img = maybe_resize(load_dynamic_image(&path)?, max_preview_size);
		let rgba = normalize_on_image(img.to_rgba8());
		encode_to_base64_png(&DynamicImage::ImageRgba8(rgba))
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn export_normal_result(
	operation: String,
	path: String,
	output_path: String,
	format: String,
	strength: Option<f32>,
	second_path: Option<String>,
	blend_factor: Option<f32>,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || {
		let rgba = load_dynamic_image(&path)?.to_rgba8();

		let result = match operation.as_str() {
			"flip" => flip_green_on_image(rgba),
			"height-to-normal" => height_to_normal_on_image(&rgba, strength.unwrap_or(1.0)),
			"blend" => {
				let second = second_path.as_deref().ok_or("Second path required for blend")?;
				let rgba_b = load_dynamic_image(second)?.to_rgba8();
				blend_normals_on_image(&rgba, &rgba_b, blend_factor.unwrap_or(0.5))
			}
			"normalize" => normalize_on_image(rgba),
			_ => return Err(format!("Unknown operation: {}", operation)),
		};

		save_image(&DynamicImage::ImageRgba8(result), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_flat_normal(w: u32, h: u32) -> RgbaImage {
		let mut img = RgbaImage::new(w, h);
		for pixel in img.pixels_mut() {
			*pixel = image::Rgba([128, 128, 255, 255]);
		}
		img
	}

	#[test]
	fn flip_green_inverts_green_channel() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([100, 200, 50, 255]));
		let p = *flip_green_on_image(img).get_pixel(0, 0);
		assert_eq!(p, image::Rgba([100, 55, 50, 255]));
	}

	#[test]
	fn flip_green_double_flip_is_identity() {
		let mut img = RgbaImage::new(2, 1);
		img.put_pixel(0, 0, image::Rgba([10, 20, 30, 40]));
		img.put_pixel(1, 0, image::Rgba([50, 60, 70, 80]));
		assert_eq!(flip_green_on_image(flip_green_on_image(img.clone())), img);
	}

	#[test]
	fn height_to_normal_flat_produces_up_normals() {
		let mut img = RgbaImage::new(8, 8);
		for pixel in img.pixels_mut() {
			*pixel = image::Rgba([128, 128, 128, 255]);
		}
		let result = height_to_normal_on_image(&img, 1.0);
		let p = result.get_pixel(4, 4);
		assert!((p[0] as i16 - 128).abs() <= 1);
		assert!((p[1] as i16 - 128).abs() <= 1);
		assert!((p[2] as i16 - 255).abs() <= 1);
	}

	#[test]
	fn height_to_normal_gradient_has_nonzero_x() {
		let mut img = RgbaImage::new(8, 8);
		for y in 0..8 {
			for x in 0..8 {
				let v = (x * 32) as u8;
				img.put_pixel(x, y, image::Rgba([v, v, v, 255]));
			}
		}
		let normal = height_to_normal_on_image(&img, 2.0);
		let p = normal.get_pixel(4, 4);
		assert!((p[0] as i16 - 128).abs() > 5);
	}

	#[test]
	fn normalize_flat_normal_is_idempotent() {
		let img = make_flat_normal(4, 4);
		let result = normalize_on_image(img.clone());
		for (x, y, original) in img.enumerate_pixels() {
			let n = result.get_pixel(x, y);
			for ch in 0..3 {
				assert!((original[ch] as i16 - n[ch] as i16).abs() <= 1);
			}
		}
	}

	#[test]
	fn normalize_produces_unit_vectors() {
		let mut img = RgbaImage::new(2, 1);
		img.put_pixel(0, 0, image::Rgba([200, 200, 200, 255]));
		img.put_pixel(1, 0, image::Rgba([255, 128, 128, 255]));
		for pixel in normalize_on_image(img).pixels() {
			let nx = pixel[0] as f32 / 255.0 * 2.0 - 1.0;
			let ny = pixel[1] as f32 / 255.0 * 2.0 - 1.0;
			let nz = pixel[2] as f32 / 255.0 * 2.0 - 1.0;
			assert!(((nx * nx + ny * ny + nz * nz).sqrt() - 1.0).abs() < 0.05);
		}
	}

	#[test]
	fn blend_zero_factor_returns_base() {
		let base = make_flat_normal(4, 4);
		let mut detail = RgbaImage::new(4, 4);
		for pixel in detail.pixels_mut() {
			*pixel = image::Rgba([200, 100, 200, 255]);
		}
		for pixel in blend_normals_on_image(&base, &detail, 0.0).pixels() {
			assert!((pixel[0] as i16 - 128).abs() <= 2);
			assert!((pixel[1] as i16 - 128).abs() <= 2);
		}
	}

	#[test]
	fn blend_mismatched_sizes_resizes_second() {
		let base = make_flat_normal(4, 4);
		let detail = make_flat_normal(8, 8);
		assert_eq!(blend_normals_on_image(&base, &detail, 0.5).dimensions(), (4, 4));
	}
}

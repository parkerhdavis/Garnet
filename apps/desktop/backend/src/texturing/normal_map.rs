// SPDX-License-Identifier: AGPL-3.0-or-later
//! Normal-map operations for the 3D Texturing plugin: flip-green (DX↔GL),
//! height-to-normal (Sobel), blend (Reoriented Normal Mapping), and re-
//! normalize. The pure `*_on_image` functions are reused by the Automations
//! module's FlipGreen / Normalize steps. Ported from Packi's normal_map.rs.
//!
//! Operates on a normalized `Rgba32FImage` (0..1) so a 16-bit heightmap feeds
//! height-to-normal at full precision and high-bit normal maps round-trip
//! correctly (green-flip is `1.0 - g`, not the byte-only `255 - g`).
//! Quantization to the output depth happens in `save_image`.

use image::{DynamicImage, Rgba32FImage};

use crate::image_io::{encode_to_base64_png, load_dynamic_image, maybe_resize, save_image};

// --- Pure in-memory image-processing functions ---

/// Flip the green channel of an RGBA image (DX ↔ OpenGL convention swap).
pub fn flip_green_on_image(mut rgba: Rgba32FImage) -> Rgba32FImage {
	for pixel in rgba.pixels_mut() {
		pixel[1] = 1.0 - pixel[1];
	}
	rgba
}

/// Generate a normal map from an RGBA heightmap via Sobel filtering.
pub fn height_to_normal_on_image(rgba: &Rgba32FImage, strength: f32) -> Rgba32FImage {
	let (w, h) = rgba.dimensions();
	// Precompute a normalized luminance heightfield (Rec. 709).
	let gray: Vec<f32> = rgba
		.pixels()
		.map(|p| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
		.collect();
	let mut normal = Rgba32FImage::new(w, h);

	for y in 0..h {
		for x in 0..w {
			let sample = |sx: i32, sy: i32| -> f32 {
				let cx = sx.clamp(0, w as i32 - 1) as u32;
				let cy = sy.clamp(0, h as i32 - 1) as u32;
				gray[(cy * w + cx) as usize]
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

			normal.put_pixel(
				x,
				y,
				image::Rgba([nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5, 1.0]),
			);
		}
	}

	normal
}

/// Blend two RGBA normal maps using Reoriented Normal Mapping (RNM). `rgba_b`
/// is resized to match `rgba_a` if dimensions differ.
pub fn blend_normals_on_image(
	rgba_a: &Rgba32FImage,
	rgba_b: &Rgba32FImage,
	blend_factor: f32,
) -> Rgba32FImage {
	let (w, h) = rgba_a.dimensions();

	let resized;
	let rgba_b = if rgba_b.dimensions() != (w, h) {
		resized = image::imageops::resize(rgba_b, w, h, image::imageops::FilterType::Lanczos3);
		&resized
	} else {
		rgba_b
	};

	let mut result = Rgba32FImage::new(w, h);

	for y in 0..h {
		for x in 0..w {
			let pa = rgba_a.get_pixel(x, y);
			let pb = rgba_b.get_pixel(x, y);

			let a = [
				pa[0] * 2.0 - 1.0,
				pa[1] * 2.0 - 1.0,
				pa[2] * 2.0 - 1.0,
			];
			let b = [
				pb[0] * 2.0 - 1.0,
				pb[1] * 2.0 - 1.0,
				pb[2] * 2.0 - 1.0,
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

			result.put_pixel(
				x,
				y,
				image::Rgba([r[0] * 0.5 + 0.5, r[1] * 0.5 + 0.5, r[2] * 0.5 + 0.5, 1.0]),
			);
		}
	}

	result
}

/// Re-normalize vectors to unit length in an RGBA normal map.
pub fn normalize_on_image(mut rgba: Rgba32FImage) -> Rgba32FImage {
	for pixel in rgba.pixels_mut() {
		let mut n = [pixel[0] * 2.0 - 1.0, pixel[1] * 2.0 - 1.0, pixel[2] * 2.0 - 1.0];

		let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
		if len > 1e-6 {
			n[0] /= len;
			n[1] /= len;
			n[2] /= len;
		}

		pixel[0] = n[0] * 0.5 + 0.5;
		pixel[1] = n[1] * 0.5 + 0.5;
		pixel[2] = n[2] * 0.5 + 0.5;
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
		let rgba = flip_green_on_image(img.to_rgba32f());
		encode_to_base64_png(&DynamicImage::ImageRgba32F(rgba))
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
		let result = height_to_normal_on_image(&img.to_rgba32f(), strength);
		encode_to_base64_png(&DynamicImage::ImageRgba32F(result))
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
		let result =
			blend_normals_on_image(&img_a.to_rgba32f(), &img_b.to_rgba32f(), blend_factor);
		encode_to_base64_png(&DynamicImage::ImageRgba32F(result))
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
		let rgba = normalize_on_image(img.to_rgba32f());
		encode_to_base64_png(&DynamicImage::ImageRgba32F(rgba))
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
		let rgba = load_dynamic_image(&path)?.to_rgba32f();

		let result = match operation.as_str() {
			"flip" => flip_green_on_image(rgba),
			"height-to-normal" => height_to_normal_on_image(&rgba, strength.unwrap_or(1.0)),
			"blend" => {
				let second = second_path.as_deref().ok_or("Second path required for blend")?;
				let rgba_b = load_dynamic_image(second)?.to_rgba32f();
				blend_normals_on_image(&rgba, &rgba_b, blend_factor.unwrap_or(0.5))
			}
			"normalize" => normalize_on_image(rgba),
			_ => return Err(format!("Unknown operation: {}", operation)),
		};

		save_image(&DynamicImage::ImageRgba32F(result), &output_path, &format)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::Rgba;

	const EPS: f32 = 1.5 / 255.0;

	fn close(a: f32, b: f32) -> bool {
		(a - b).abs() <= EPS
	}

	fn n(v: u8) -> f32 {
		v as f32 / 255.0
	}

	fn make_flat_normal(w: u32, h: u32) -> Rgba32FImage {
		Rgba32FImage::from_pixel(w, h, Rgba([n(128), n(128), 1.0, 1.0]))
	}

	#[test]
	fn flip_green_inverts_green_channel() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([n(100), n(200), n(50), 1.0]));
		let p = *flip_green_on_image(img).get_pixel(0, 0);
		assert!(close(p[0], n(100)));
		assert!(close(p[1], n(55))); // 1 - 200/255 = 55/255
		assert!(close(p[2], n(50)));
	}

	#[test]
	fn flip_green_double_flip_is_identity() {
		let mut img = Rgba32FImage::new(2, 1);
		img.put_pixel(0, 0, Rgba([n(10), n(20), n(30), n(40)]));
		img.put_pixel(1, 0, Rgba([n(50), n(60), n(70), n(80)]));
		let out = flip_green_on_image(flip_green_on_image(img.clone()));
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..4 {
				assert!(close(p[ch], q[ch]));
			}
		}
	}

	#[test]
	fn height_to_normal_flat_produces_up_normals() {
		let img = Rgba32FImage::from_pixel(8, 8, Rgba([n(128), n(128), n(128), 1.0]));
		let result = height_to_normal_on_image(&img, 1.0);
		let p = result.get_pixel(4, 4);
		assert!(close(p[0], 0.5));
		assert!(close(p[1], 0.5));
		assert!(close(p[2], 1.0));
	}

	#[test]
	fn height_to_normal_gradient_has_nonzero_x() {
		let mut img = Rgba32FImage::new(8, 8);
		for y in 0..8 {
			for x in 0..8 {
				let v = n((x * 32) as u8);
				img.put_pixel(x, y, Rgba([v, v, v, 1.0]));
			}
		}
		let normal = height_to_normal_on_image(&img, 2.0);
		let p = normal.get_pixel(4, 4);
		assert!((p[0] - 0.5).abs() > 5.0 / 255.0);
	}

	#[test]
	fn normalize_flat_normal_is_idempotent() {
		let img = make_flat_normal(4, 4);
		let result = normalize_on_image(img.clone());
		for (x, y, original) in img.enumerate_pixels() {
			let nn = result.get_pixel(x, y);
			for ch in 0..3 {
				assert!(close(original[ch], nn[ch]));
			}
		}
	}

	#[test]
	fn normalize_produces_unit_vectors() {
		let mut img = Rgba32FImage::new(2, 1);
		img.put_pixel(0, 0, Rgba([n(200), n(200), n(200), 1.0]));
		img.put_pixel(1, 0, Rgba([1.0, n(128), n(128), 1.0]));
		for pixel in normalize_on_image(img).pixels() {
			let nx = pixel[0] * 2.0 - 1.0;
			let ny = pixel[1] * 2.0 - 1.0;
			let nz = pixel[2] * 2.0 - 1.0;
			assert!(((nx * nx + ny * ny + nz * nz).sqrt() - 1.0).abs() < 0.05);
		}
	}

	#[test]
	fn blend_zero_factor_returns_base() {
		let base = make_flat_normal(4, 4);
		let detail = Rgba32FImage::from_pixel(4, 4, Rgba([n(200), n(100), n(200), 1.0]));
		for pixel in blend_normals_on_image(&base, &detail, 0.0).pixels() {
			assert!(close(pixel[0], 0.5));
			assert!(close(pixel[1], 0.5));
		}
	}

	#[test]
	fn blend_mismatched_sizes_resizes_second() {
		let base = make_flat_normal(4, 4);
		let detail = make_flat_normal(8, 8);
		assert_eq!(
			blend_normals_on_image(&base, &detail, 0.5).dimensions(),
			(4, 4)
		);
	}
}

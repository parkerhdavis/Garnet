// SPDX-License-Identifier: AGPL-3.0-or-later
//! Geometric transforms: crop, resize, rotate (90° increments and arbitrary
//! angle via bilinear sampling), and corner-round (alpha mask). All take and
//! return `DynamicImage` so they compose cleanly inside the pipeline.

use image::{imageops::FilterType, DynamicImage, Rgba, RgbaImage};

/// Crop. Coordinates clamp to the image rect; an empty intersection returns
/// a 1×1 transparent pixel rather than erroring (downstream tools won't
/// crash if a user drags a crop box outside the canvas).
pub fn crop(img: &DynamicImage, x: u32, y: u32, w: u32, h: u32) -> DynamicImage {
	let (iw, ih) = (img.width(), img.height());
	if x >= iw || y >= ih || w == 0 || h == 0 {
		return DynamicImage::ImageRgba8(RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 0])));
	}
	let cw = w.min(iw - x);
	let ch = h.min(ih - y);
	img.crop_imm(x, y, cw, ch)
}

/// Resize to exact dimensions using Lanczos3 (a sensible high-quality
/// default for both up- and downscaling). `0` for either dimension is
/// rejected — the frontend should clamp to ≥1 before sending.
pub fn resize(img: &DynamicImage, w: u32, h: u32) -> Result<DynamicImage, String> {
	if w == 0 || h == 0 {
		return Err(format!("resize dimensions must be ≥1, got {}×{}", w, h));
	}
	Ok(img.resize_exact(w, h, FilterType::Lanczos3))
}

/// Rotate by an arbitrary angle in degrees. Positive = clockwise. 90°
/// multiples short-circuit to `image::imageops::rotate*` for an exact
/// pixel-preserving result; other angles go through a bilinear sampler
/// that expands the canvas to fit the rotated content (corners outside
/// the original image become transparent).
pub fn rotate(img: &DynamicImage, angle_deg: f32) -> DynamicImage {
	let normalized = ((angle_deg % 360.0) + 360.0) % 360.0;
	// Fast path for exact 90° multiples — avoids bilinear blur and gives
	// pixel-perfect output for the common rotate-buttons case.
	if (normalized - 0.0).abs() < 1e-3 {
		return img.clone();
	}
	if (normalized - 90.0).abs() < 1e-3 {
		return DynamicImage::ImageRgba8(image::imageops::rotate90(img));
	}
	if (normalized - 180.0).abs() < 1e-3 {
		return DynamicImage::ImageRgba8(image::imageops::rotate180(img));
	}
	if (normalized - 270.0).abs() < 1e-3 {
		return DynamicImage::ImageRgba8(image::imageops::rotate270(img));
	}
	rotate_arbitrary(img, normalized)
}

/// Round the corners of the image by drawing a soft alpha mask: any pixel
/// outside the rounded-rect's interior gets its alpha multiplied by an
/// anti-aliased coverage factor. `radius_px` is clamped to half the
/// shorter axis (a circle is the upper bound).
pub fn corner_round(img: &DynamicImage, radius_px: u32) -> DynamicImage {
	let mut rgba = img.to_rgba8();
	let (w, h) = rgba.dimensions();
	let max_r = (w.min(h) / 2) as f32;
	let r = (radius_px as f32).min(max_r);
	if r <= 0.0 {
		return DynamicImage::ImageRgba8(rgba);
	}
	let rsq = r * r;
	for (x, y, pixel) in rgba.enumerate_pixels_mut() {
		let fx = x as f32 + 0.5;
		let fy = y as f32 + 0.5;
		// Distance from the nearest rounded-corner center, or 0 if the
		// pixel sits in the rect's straight interior.
		let cx = if fx < r {
			r - fx
		} else if fx > w as f32 - r {
			fx - (w as f32 - r)
		} else {
			0.0
		};
		let cy = if fy < r {
			r - fy
		} else if fy > h as f32 - r {
			fy - (h as f32 - r)
		} else {
			0.0
		};
		if cx == 0.0 && cy == 0.0 {
			continue;
		}
		let dsq = cx * cx + cy * cy;
		if dsq <= rsq {
			continue;
		}
		// 1 px soft edge: full transparency beyond r+0.5, full opacity
		// before r-0.5, linear ramp in between.
		let d = dsq.sqrt();
		let coverage = (r + 0.5 - d).clamp(0.0, 1.0);
		let a = pixel[3] as f32 * coverage;
		pixel[3] = a.round() as u8;
	}
	DynamicImage::ImageRgba8(rgba)
}

/// Bilinear-sampled rotation onto an expanded canvas. Out-of-source
/// samples produce transparent pixels.
fn rotate_arbitrary(img: &DynamicImage, angle_deg: f32) -> DynamicImage {
	let src = img.to_rgba8();
	let (sw, sh) = src.dimensions();
	let radians = angle_deg.to_radians();
	let cos = radians.cos();
	let sin = radians.sin();

	// New bounding box that contains the rotated source rect.
	let new_w = (sw as f32 * cos.abs() + sh as f32 * sin.abs()).ceil() as u32;
	let new_h = (sw as f32 * sin.abs() + sh as f32 * cos.abs()).ceil() as u32;
	let mut out = RgbaImage::from_pixel(new_w, new_h, Rgba([0, 0, 0, 0]));

	let cx_src = sw as f32 / 2.0;
	let cy_src = sh as f32 / 2.0;
	let cx_out = new_w as f32 / 2.0;
	let cy_out = new_h as f32 / 2.0;

	for (x, y, dest) in out.enumerate_pixels_mut() {
		let dx = x as f32 + 0.5 - cx_out;
		let dy = y as f32 + 0.5 - cy_out;
		// Inverse mapping: rotate by -angle.
		let sx = dx * cos + dy * sin + cx_src - 0.5;
		let sy = -dx * sin + dy * cos + cy_src - 0.5;
		if let Some(p) = sample_bilinear(&src, sx, sy) {
			*dest = p;
		}
	}
	DynamicImage::ImageRgba8(out)
}

fn sample_bilinear(src: &RgbaImage, x: f32, y: f32) -> Option<Rgba<u8>> {
	let (w, h) = src.dimensions();
	if x < 0.0 || y < 0.0 || x > (w - 1) as f32 || y > (h - 1) as f32 {
		return None;
	}
	let x0 = x.floor() as u32;
	let y0 = y.floor() as u32;
	let x1 = (x0 + 1).min(w - 1);
	let y1 = (y0 + 1).min(h - 1);
	let fx = x - x0 as f32;
	let fy = y - y0 as f32;
	let p00 = src.get_pixel(x0, y0).0;
	let p10 = src.get_pixel(x1, y0).0;
	let p01 = src.get_pixel(x0, y1).0;
	let p11 = src.get_pixel(x1, y1).0;
	let mut out = [0u8; 4];
	for ch in 0..4 {
		let top = p00[ch] as f32 * (1.0 - fx) + p10[ch] as f32 * fx;
		let bot = p01[ch] as f32 * (1.0 - fx) + p11[ch] as f32 * fx;
		out[ch] = (top * (1.0 - fy) + bot * fy).round() as u8;
	}
	Some(Rgba(out))
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::{GenericImageView, Rgba};

	fn solid(w: u32, h: u32, color: [u8; 4]) -> DynamicImage {
		DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(color)))
	}

	#[test]
	fn crop_inside_returns_subimage() {
		let img = solid(10, 10, [255, 0, 0, 255]);
		let c = crop(&img, 2, 3, 4, 5);
		assert_eq!(c.dimensions(), (4, 5));
	}

	#[test]
	fn crop_clamps_to_bounds() {
		let img = solid(10, 10, [0, 0, 0, 255]);
		let c = crop(&img, 5, 5, 100, 100);
		assert_eq!(c.dimensions(), (5, 5));
	}

	#[test]
	fn crop_fully_outside_returns_1px() {
		let img = solid(10, 10, [0, 0, 0, 255]);
		let c = crop(&img, 20, 20, 4, 4);
		assert_eq!(c.dimensions(), (1, 1));
	}

	#[test]
	fn resize_exact_dimensions() {
		let img = solid(10, 10, [0, 0, 0, 255]);
		let r = resize(&img, 50, 25).unwrap();
		assert_eq!(r.dimensions(), (50, 25));
	}

	#[test]
	fn resize_zero_dim_errors() {
		let img = solid(10, 10, [0, 0, 0, 255]);
		assert!(resize(&img, 0, 10).is_err());
	}

	#[test]
	fn rotate_90_swaps_axes() {
		let img = solid(20, 10, [0, 0, 0, 255]);
		let r = rotate(&img, 90.0);
		assert_eq!(r.dimensions(), (10, 20));
	}

	#[test]
	fn rotate_180_keeps_dims() {
		let img = solid(20, 10, [0, 0, 0, 255]);
		let r = rotate(&img, 180.0);
		assert_eq!(r.dimensions(), (20, 10));
	}

	#[test]
	fn rotate_360_is_noop() {
		let img = solid(8, 8, [128, 64, 32, 255]);
		let r = rotate(&img, 360.0);
		assert_eq!(r.dimensions(), img.dimensions());
	}

	#[test]
	fn rotate_45_expands_canvas() {
		let img = solid(10, 10, [255, 255, 255, 255]);
		let r = rotate(&img, 45.0);
		let (w, h) = r.dimensions();
		// √2 × 10 ≈ 14.14, ceil to 15.
		assert!(w >= 14 && w <= 16, "width {w}");
		assert!(h >= 14 && h <= 16, "height {h}");
	}

	#[test]
	fn rotate_arbitrary_leaves_corners_transparent() {
		let img = solid(10, 10, [255, 255, 255, 255]);
		let r = rotate(&img, 30.0);
		let rgba = r.to_rgba8();
		// Top-left corner pixel of the new canvas must be outside the
		// rotated source, hence transparent.
		assert_eq!(rgba.get_pixel(0, 0)[3], 0);
	}

	#[test]
	fn corner_round_zero_radius_is_noop() {
		let img = solid(8, 8, [200, 100, 50, 255]);
		let r = corner_round(&img, 0);
		assert_eq!(r.to_rgba8(), img.to_rgba8());
	}

	#[test]
	fn corner_round_clears_corner_pixels() {
		let img = solid(10, 10, [200, 100, 50, 255]);
		let r = corner_round(&img, 4);
		let rgba = r.to_rgba8();
		// The (0,0) corner is well outside the rounded interior — alpha must drop.
		assert!(rgba.get_pixel(0, 0)[3] < 128);
		// Center pixel must be fully opaque.
		assert_eq!(rgba.get_pixel(5, 5)[3], 255);
	}

	#[test]
	fn corner_round_clamps_radius() {
		let img = solid(10, 10, [200, 100, 50, 255]);
		// Radius far exceeds half-size; should still produce a valid image.
		let r = corner_round(&img, 999);
		assert_eq!(r.dimensions(), (10, 10));
	}
}

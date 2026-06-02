// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pixel-space adjustments: hue, saturation, brightness, contrast, white
//! balance, and a generic 256-entry luminance LUT. Operates on a normalized
//! `Rgba32FImage` (channel values 0..1; may exceed 1.0 for HDR sources) so
//! chained adjustments preserve full precision — quantization to 8/16-bit
//! happens only at save time.
//!
//! These match the live editor preview exactly. The preview is a CSS/SVG
//! `filter:` chain applied to the source `<img>` on the GPU, so the commit must
//! use the same math or the saved file won't look like the preview. (It didn't:
//! the old HSL hue/saturation and additive brightness diverged hard from the
//! CSS `hue-rotate`/`saturate` matrices and `brightness` multiply.) Each op now
//! mirrors its preview filter: hue/saturation use the W3C Filter Effects color
//! matrices (`hue-rotate(deg)` / `saturate(1+offset)`); brightness is a
//! per-channel multiply by `1+offset`; contrast is `(v-0.5)*(1+amount)+0.5`;
//! temperature/tint are channel multipliers (the preview's `feColorMatrix`);
//! the luminance curve is an interpolated 8-bit LUT (the `feComponentTransfer`
//! table). All math is in the stored sRGB-encoded space, like the CSS filters,
//! with no linearization.
//!
//! This diverges from standalone Packi (still HSL); a shared processing crate
//! should adopt this version. Parallelized with rayon across pixel rows.

use image::Rgba32FImage;
use rayon::prelude::*;

/// Apply a 256-entry luminance curve LUT to an RGBA-f32 image. The LUT is
/// authored in the 8-bit domain (the frontend's curve editor emits 256 u8
/// entries, fed to the preview as an SVG `feComponentTransfer` table), so for
/// f32 inputs we linearly interpolate between the two nearest entries over the
/// 0..1 range — matching the GPU table interpolation, and giving 8-bit-exact
/// inputs the old nearest-index result.
pub fn apply_luminance_curve(mut rgba: Rgba32FImage, lut: &[u8; 256]) -> Rgba32FImage {
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		p[0] = sample_lut(lut, p[0]);
		p[1] = sample_lut(lut, p[1]);
		p[2] = sample_lut(lut, p[2]);
	});
	rgba
}

/// Interpolated 8-bit LUT lookup for a normalized channel value.
fn sample_lut(lut: &[u8; 256], v: f32) -> f32 {
	let x = v.clamp(0.0, 1.0) * 255.0;
	let i0 = x.floor() as usize; // 0..=255
	let i1 = (i0 + 1).min(255);
	let frac = x - i0 as f32;
	let a = lut[i0] as f32;
	let b = lut[i1] as f32;
	(a + (b - a) * frac) / 255.0
}

/// Brightness in [-1, 1]: CSS `brightness(1+offset)` — a per-channel multiply.
pub fn apply_brightness(rgba: Rgba32FImage, offset: f32) -> Rgba32FImage {
	let f = (1.0 + offset.clamp(-1.0, 1.0)).max(0.0);
	apply_rgb_scale(rgba, f, f, f)
}

/// Contrast in [-1, 1]. 0 is identity, +1 doubles the slope around the
/// midpoint (0.5), -1 collapses to flat mid-gray. Matches CSS `contrast()`.
pub fn apply_contrast(mut rgba: Rgba32FImage, amount: f32) -> Rgba32FImage {
	let slope = 1.0 + amount.clamp(-1.0, 1.0);
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		p[0] = ((p[0] - 0.5) * slope + 0.5).clamp(0.0, 1.0);
		p[1] = ((p[1] - 0.5) * slope + 0.5).clamp(0.0, 1.0);
		p[2] = ((p[2] - 0.5) * slope + 0.5).clamp(0.0, 1.0);
	});
	rgba
}

/// Shift hue by `offset` degrees using the W3C `hue-rotate` color matrix
/// (luma-preserving rotation in sRGB), matching the preview's CSS filter.
pub fn apply_hue(rgba: Rgba32FImage, offset: f32) -> Rgba32FImage {
	let a = offset.to_radians();
	let (c, s) = (a.cos(), a.sin());
	#[rustfmt::skip]
	let m = [
		0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
		0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
		0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
	];
	apply_color_matrix(rgba, m)
}

/// Scale saturation by `offset` in [-1, 1] using the W3C `saturate` color
/// matrix (`saturate(1+offset)`), matching the preview's CSS filter.
pub fn apply_saturation(rgba: Rgba32FImage, offset: f32) -> Rgba32FImage {
	let sat = (1.0 + offset.clamp(-1.0, 1.0)).max(0.0);
	#[rustfmt::skip]
	let m = [
		0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat,
		0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat,
		0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat,
	];
	apply_color_matrix(rgba, m)
}

/// Channel-multiplier white-balance temperature in [-1, 1]. Positive
/// values warm the image (boost R, attenuate B); negative values cool
/// it. The 0.3 sensitivity matches the preview's `feColorMatrix`.
pub fn apply_temperature(rgba: Rgba32FImage, amount: f32) -> Rgba32FImage {
	let t = amount.clamp(-1.0, 1.0);
	apply_rgb_scale(rgba, 1.0 + 0.3 * t, 1.0, 1.0 - 0.3 * t)
}

/// Channel-multiplier white-balance tint in [-1, 1]. Positive pushes
/// toward magenta (attenuate G); negative pushes toward green (boost G).
pub fn apply_tint(rgba: Rgba32FImage, amount: f32) -> Rgba32FImage {
	let t = amount.clamp(-1.0, 1.0);
	apply_rgb_scale(rgba, 1.0, 1.0 - 0.3 * t, 1.0)
}

fn apply_rgb_scale(mut rgba: Rgba32FImage, r: f32, g: f32, b: f32) -> Rgba32FImage {
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		p[0] = (p[0] * r).clamp(0.0, 1.0);
		p[1] = (p[1] * g).clamp(0.0, 1.0);
		p[2] = (p[2] * b).clamp(0.0, 1.0);
	});
	rgba
}

/// Apply a 3×3 RGB color matrix (row-major), clamping to 0..1. Alpha is left
/// untouched. Used by the hue-rotate and saturate filters.
fn apply_color_matrix(mut rgba: Rgba32FImage, m: [f32; 9]) -> Rgba32FImage {
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		let (r, g, b) = (p[0], p[1], p[2]);
		p[0] = (m[0] * r + m[1] * g + m[2] * b).clamp(0.0, 1.0);
		p[1] = (m[3] * r + m[4] * g + m[5] * b).clamp(0.0, 1.0);
		p[2] = (m[6] * r + m[7] * g + m[8] * b).clamp(0.0, 1.0);
	});
	rgba
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::Rgba;

	/// Tolerance for f32 channel comparisons (≈ <1 part in 1000).
	const EPS: f32 = 1.0 / 1000.0;

	fn make_test_image() -> Rgba32FImage {
		let mut img = Rgba32FImage::new(2, 2);
		img.put_pixel(0, 0, Rgba([1.0, 0.0, 0.0, 1.0]));
		img.put_pixel(1, 0, Rgba([0.0, 1.0, 0.0, 1.0]));
		img.put_pixel(0, 1, Rgba([0.0, 0.0, 1.0, 1.0]));
		img.put_pixel(1, 1, Rgba([0.5, 0.5, 0.5, 1.0]));
		img
	}

	fn close(a: f32, b: f32) -> bool {
		(a - b).abs() <= EPS
	}

	#[test]
	fn luminance_identity_lut_noop() {
		let img = make_test_image();
		let lut = std::array::from_fn::<u8, 256, _>(|i| i as u8);
		let out = apply_luminance_curve(img.clone(), &lut);
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..3 {
				assert!(close(p[ch], q[ch]), "ch{ch}: {} vs {}", p[ch], q[ch]);
			}
		}
	}

	#[test]
	fn luminance_interpolates_subbyte_values() {
		let lut = std::array::from_fn::<u8, 256, _>(|i| (i * 2).min(255) as u8);
		let mut img = Rgba32FImage::new(1, 1);
		// 100.5/255 sits halfway between LUT[100]=200 and LUT[101]=202 → 201/255.
		img.put_pixel(0, 0, Rgba([100.5 / 255.0, 0.0, 0.0, 1.0]));
		let out = apply_luminance_curve(img, &lut);
		assert!(close(out.get_pixel(0, 0)[0], 201.0 / 255.0));
	}

	#[test]
	fn brightness_is_multiplicative() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.4, 0.4, 0.4, 0.165]));
		let out = apply_brightness(img, 0.5); // ×1.5
		let p = out.get_pixel(0, 0);
		assert!(close(p[0], 0.6));
		assert!(close(p[3], 0.165), "alpha preserved");
	}

	#[test]
	fn brightness_clamps_high() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.8, 0.8, 0.8, 1.0]));
		let out = apply_brightness(img, 1.0); // ×2
		assert!(close(out.get_pixel(0, 0)[0], 1.0));
	}

	#[test]
	fn contrast_zero_is_noop() {
		let img = make_test_image();
		let out = apply_contrast(img.clone(), 0.0);
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..3 {
				assert!(close(p[ch], q[ch]));
			}
		}
	}

	#[test]
	fn contrast_minus_one_flattens_to_midgray() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.0, 1.0, 0.5, 1.0]));
		let out = apply_contrast(img, -1.0);
		let p = out.get_pixel(0, 0);
		for ch in 0..3 {
			assert!(close(p[ch], 0.5), "ch{ch} = {}", p[ch]);
		}
	}

	#[test]
	fn hue_zero_offset_is_noop() {
		let img = make_test_image();
		let out = apply_hue(img.clone(), 0.0);
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..3 {
				assert!(close(p[ch], q[ch]), "{} vs {}", p[ch], q[ch]);
			}
		}
	}

	#[test]
	fn hue_full_rotation_returns_original() {
		let img = make_test_image();
		let out = apply_hue(img.clone(), 360.0);
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..3 {
				assert!(close(p[ch], q[ch]), "{} vs {}", p[ch], q[ch]);
			}
		}
	}

	#[test]
	fn saturation_zero_is_noop() {
		let img = make_test_image();
		let out = apply_saturation(img.clone(), 0.0);
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..3 {
				assert!(close(p[ch], q[ch]));
			}
		}
	}

	#[test]
	fn saturation_negative_desaturates_red() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([1.0, 0.0, 0.0, 1.0]));
		let out = apply_saturation(img, -0.5); // saturate(0.5)
		let p = out.get_pixel(0, 0);
		assert!(p[0] < 1.0);
		assert!(p[1] > 0.0);
		assert!(p[2] > 0.0);
	}

	#[test]
	fn saturation_minus_one_is_grayscale() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([1.0, 0.0, 0.0, 1.0]));
		let out = apply_saturation(img, -1.0); // saturate(0) → luma
		let p = out.get_pixel(0, 0);
		// Pure red's luma ≈ 0.213; all three channels equal it.
		assert!(close(p[0], p[1]) && close(p[1], p[2]));
		assert!(close(p[0], 0.213));
	}

	#[test]
	fn temperature_positive_warms() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.4, 0.4, 0.4, 1.0]));
		let out = apply_temperature(img, 1.0);
		let p = out.get_pixel(0, 0);
		assert!(p[0] > 0.4, "R should rise");
		assert!(p[2] < 0.4, "B should fall");
		assert!(close(p[1], 0.4), "G unchanged");
		assert!(close(p[3], 1.0));
	}

	#[test]
	fn temperature_negative_cools() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.4, 0.4, 0.4, 1.0]));
		let out = apply_temperature(img, -1.0);
		let p = out.get_pixel(0, 0);
		assert!(p[0] < 0.4);
		assert!(p[2] > 0.4);
	}

	#[test]
	fn tint_positive_pushes_magenta() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.4, 0.4, 0.4, 1.0]));
		let out = apply_tint(img, 1.0);
		let p = out.get_pixel(0, 0);
		assert!(p[1] < 0.4, "G should fall (toward magenta)");
		assert!(close(p[0], 0.4));
		assert!(close(p[2], 0.4));
	}

	#[test]
	fn temperature_clamps_to_unit_range() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.98, 0.98, 0.98, 1.0]));
		let out = apply_temperature(img, 1.0);
		assert!(close(out.get_pixel(0, 0)[0], 1.0));
	}
}

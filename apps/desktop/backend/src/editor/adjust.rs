// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pixel-space adjustments: hue, saturation, brightness, contrast, and a
//! generic 256-entry luminance LUT. Operates on a normalized `Rgba32FImage`
//! (channel values in 0..1; may exceed 1.0 for HDR sources) so chained
//! adjustments preserve full precision — quantization to 8/16-bit happens only
//! at save time. The HSL conversions and the hue / saturation curves were
//! ported from Packi's 8-bit `adjust.rs`; the math is identical (Packi already
//! computed in f32 internally and quantized per-op), just without the early
//! round-trip to bytes. NOTE: Garnet's stack is now f32 while standalone Packi
//! is still 8-bit — the eventual shared processing crate should adopt this f32
//! version. All math stays in the stored (sRGB-encoded) space, matching the
//! prior 8-bit behavior; no linearization.
//!
//! Every adjust function is parallelized with rayon across pixel rows.
//! Slider drags fire many calls per second on multi-megapixel previews;
//! single-threaded per-pixel HSL was the dominant cost in v1.

use image::Rgba32FImage;
use rayon::prelude::*;

/// Apply a 256-entry luminance curve LUT to an RGBA-f32 image. The LUT is
/// authored in the 8-bit domain (the frontend's curve editor emits 256 u8
/// entries), so for f32 inputs we linearly interpolate between the two nearest
/// entries over the 0..1 range — an 8-bit-exact input reproduces the old
/// nearest-index result, while 16-bit/float inputs get a smooth mapping.
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

/// Brightness in [-1, 1]: a linear add on each channel (normalized).
pub fn apply_brightness(mut rgba: Rgba32FImage, offset: f32) -> Rgba32FImage {
	let shift = offset.clamp(-1.0, 1.0);
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		p[0] = (p[0] + shift).clamp(0.0, 1.0);
		p[1] = (p[1] + shift).clamp(0.0, 1.0);
		p[2] = (p[2] + shift).clamp(0.0, 1.0);
	});
	rgba
}

/// Contrast in [-1, 1]. 0 is identity, +1 doubles the slope around the
/// midpoint (0.5), -1 collapses to flat mid-gray.
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

/// Shift hue by `offset` degrees.
pub fn apply_hue(mut rgba: Rgba32FImage, offset: f32) -> Rgba32FImage {
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		let (h, s, l) = rgb_to_hsl(p[0], p[1], p[2]);
		let (r, g, b) = hsl_to_rgb((h + offset).rem_euclid(360.0), s, l);
		p[0] = r;
		p[1] = g;
		p[2] = b;
	});
	rgba
}

/// Channel-multiplier white-balance temperature in [-1, 1]. Positive
/// values warm the image (boost R, attenuate B); negative values cool
/// it. The 0.3 sensitivity matches Packi — full +1 is a strong tint, not
/// a hard cap.
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

/// Scale saturation by `offset` in [-1, 1]. Matches Packi's curve.
pub fn apply_saturation(mut rgba: Rgba32FImage, offset: f32) -> Rgba32FImage {
	let buf: &mut [f32] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		let (h, s, l) = rgb_to_hsl(p[0], p[1], p[2]);
		let new_s = (s + offset * s.max(1.0 - s)).clamp(0.0, 1.0);
		let (r, g, b) = hsl_to_rgb(h, new_s, l);
		p[0] = r;
		p[1] = g;
		p[2] = b;
	});
	rgba
}

/// RGB (normalized 0..1) → HSL. Hue in degrees, S/L in 0..1.
pub fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
	let max = r.max(g).max(b);
	let min = r.min(g).min(b);
	let l = (max + min) / 2.0;
	if (max - min).abs() < 1e-6 {
		return (0.0, 0.0, l);
	}
	let d = max - min;
	let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
	let h = if (max - r).abs() < 1e-6 {
		let mut h = (g - b) / d;
		if g < b {
			h += 6.0;
		}
		h
	} else if (max - g).abs() < 1e-6 {
		(b - r) / d + 2.0
	} else {
		(r - g) / d + 4.0
	};
	(h * 60.0, s, l)
}

/// HSL → RGB (normalized 0..1). Hue in degrees.
pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
	if s.abs() < 1e-6 {
		return (l, l, l);
	}
	let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
	let p = 2.0 * l - q;
	let h = h / 360.0;
	(
		hue_to_rgb(p, q, h + 1.0 / 3.0),
		hue_to_rgb(p, q, h),
		hue_to_rgb(p, q, h - 1.0 / 3.0),
	)
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
	if t < 0.0 {
		t += 1.0;
	}
	if t > 1.0 {
		t -= 1.0;
	}
	if t < 1.0 / 6.0 {
		return p + (q - p) * 6.0 * t;
	}
	if t < 1.0 / 2.0 {
		return q;
	}
	if t < 2.0 / 3.0 {
		return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
	}
	p
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
		// A LUT that doubles input; a value between two LUT entries should
		// interpolate rather than snap to the nearest entry.
		let lut = std::array::from_fn::<u8, 256, _>(|i| (i * 2).min(255) as u8);
		let mut img = Rgba32FImage::new(1, 1);
		// 100.5/255 sits halfway between LUT[100]=200 and LUT[101]=202 → 201/255.
		img.put_pixel(0, 0, Rgba([100.5 / 255.0, 0.0, 0.0, 1.0]));
		let out = apply_luminance_curve(img, &lut);
		assert!(close(out.get_pixel(0, 0)[0], 201.0 / 255.0));
	}

	#[test]
	fn brightness_preserves_alpha() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.4, 0.4, 0.4, 0.165]));
		let out = apply_brightness(img, 0.5);
		assert!(close(out.get_pixel(0, 0)[3], 0.165));
	}

	#[test]
	fn brightness_clamps_high() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([0.8, 0.8, 0.8, 1.0]));
		let out = apply_brightness(img, 1.0);
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
		let p = img.get_pixel(1, 1);
		let q = out.get_pixel(1, 1);
		for ch in 0..3 {
			assert!(close(p[ch], q[ch]));
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
	fn saturation_negative_desaturates_red() {
		let mut img = Rgba32FImage::new(1, 1);
		img.put_pixel(0, 0, Rgba([1.0, 0.0, 0.0, 1.0]));
		let out = apply_saturation(img, -0.5);
		let p = out.get_pixel(0, 0);
		assert!(p[0] < 1.0);
		assert!(p[1] > 0.0);
		assert!(p[2] > 0.0);
	}

	#[test]
	fn temperature_zero_is_noop() {
		let img = make_test_image();
		let out = apply_temperature(img.clone(), 0.0);
		for (p, q) in img.pixels().zip(out.pixels()) {
			for ch in 0..4 {
				assert!(close(p[ch], q[ch]));
			}
		}
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

	#[test]
	fn hsl_roundtrip_midtone() {
		let (h, s, l) = rgb_to_hsl(100.0 / 255.0, 150.0 / 255.0, 200.0 / 255.0);
		let (r, g, b) = hsl_to_rgb(h, s, l);
		assert!(close(r, 100.0 / 255.0));
		assert!(close(g, 150.0 / 255.0));
		assert!(close(b, 200.0 / 255.0));
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pixel-space adjustments: hue, saturation, brightness, contrast, and a
//! generic 256-entry luminance LUT. The HSL conversions and the hue /
//! saturation primitives are ported from Packi's `adjust.rs` so behavior
//! stays consistent across the two apps — keep the implementations in sync
//! when one side changes.
//!
//! Every adjust function is parallelized with rayon across pixel rows.
//! Slider drags fire many calls per second on multi-megapixel previews;
//! single-threaded per-pixel HSL was the dominant cost in v1.

use image::RgbaImage;
use rayon::prelude::*;

/// Apply a luminance curve LUT to an RGBA image in-place.
pub fn apply_luminance_curve(mut rgba: RgbaImage, lut: &[u8; 256]) -> RgbaImage {
	let buf: &mut [u8] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		p[0] = lut[p[0] as usize];
		p[1] = lut[p[1] as usize];
		p[2] = lut[p[2] as usize];
	});
	rgba
}

/// Brightness in [-1, 1]. Implemented as a linear add on each channel.
pub fn apply_brightness(rgba: RgbaImage, offset: f32) -> RgbaImage {
	let shift = (offset.clamp(-1.0, 1.0) * 255.0).round() as i16;
	let lut = build_lut(|v| (v as i16 + shift).clamp(0, 255) as u8);
	apply_luminance_curve(rgba, &lut)
}

/// Contrast in [-1, 1]. 0 is identity, +1 doubles the slope around the
/// midpoint, -1 collapses to flat gray.
pub fn apply_contrast(rgba: RgbaImage, amount: f32) -> RgbaImage {
	let a = amount.clamp(-1.0, 1.0);
	let slope = 1.0 + a;
	let lut = build_lut(|v| {
		let centered = v as f32 - 127.5;
		let scaled = centered * slope + 127.5;
		scaled.clamp(0.0, 255.0).round() as u8
	});
	apply_luminance_curve(rgba, &lut)
}

/// Shift hue by `offset` degrees.
pub fn apply_hue(mut rgba: RgbaImage, offset: f32) -> RgbaImage {
	let buf: &mut [u8] = &mut rgba;
	buf.par_chunks_exact_mut(4).for_each(|p| {
		let (h, s, l) = rgb_to_hsl(p[0], p[1], p[2]);
		let (r, g, b) = hsl_to_rgb((h + offset).rem_euclid(360.0), s, l);
		p[0] = r;
		p[1] = g;
		p[2] = b;
	});
	rgba
}

/// Scale saturation by `offset` in [-1, 1]. Matches Packi's curve.
pub fn apply_saturation(mut rgba: RgbaImage, offset: f32) -> RgbaImage {
	let buf: &mut [u8] = &mut rgba;
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

fn build_lut<F: Fn(u8) -> u8>(f: F) -> [u8; 256] {
	let mut out = [0u8; 256];
	for (i, slot) in out.iter_mut().enumerate() {
		*slot = f(i as u8);
	}
	out
}

pub fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
	let r = r as f32 / 255.0;
	let g = g as f32 / 255.0;
	let b = b as f32 / 255.0;
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

pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
	if s.abs() < 1e-6 {
		let v = (l * 255.0).round() as u8;
		return (v, v, v);
	}
	let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
	let p = 2.0 * l - q;
	let h = h / 360.0;
	let r = hue_to_rgb(p, q, h + 1.0 / 3.0);
	let g = hue_to_rgb(p, q, h);
	let b = hue_to_rgb(p, q, h - 1.0 / 3.0);
	(
		(r * 255.0).round() as u8,
		(g * 255.0).round() as u8,
		(b * 255.0).round() as u8,
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

	fn make_test_image() -> RgbaImage {
		let mut img = RgbaImage::new(2, 2);
		img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
		img.put_pixel(1, 0, image::Rgba([0, 255, 0, 255]));
		img.put_pixel(0, 1, image::Rgba([0, 0, 255, 255]));
		img.put_pixel(1, 1, image::Rgba([128, 128, 128, 255]));
		img
	}

	#[test]
	fn luminance_identity_lut_noop() {
		let img = make_test_image();
		let lut = std::array::from_fn::<u8, 256, _>(|i| i as u8);
		assert_eq!(apply_luminance_curve(img.clone(), &lut), img);
	}

	#[test]
	fn brightness_preserves_alpha() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([100, 100, 100, 42]));
		let out = apply_brightness(img, 0.5);
		assert_eq!(out.get_pixel(0, 0)[3], 42);
	}

	#[test]
	fn brightness_clamps_high() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([200, 200, 200, 255]));
		let out = apply_brightness(img, 1.0);
		assert_eq!(out.get_pixel(0, 0)[0], 255);
	}

	#[test]
	fn contrast_zero_is_noop() {
		let img = make_test_image();
		let out = apply_contrast(img.clone(), 0.0);
		// Allow ±1 for float rounding around the midpoint.
		for (x, y, p) in img.enumerate_pixels() {
			let q = out.get_pixel(x, y);
			for ch in 0..3 {
				assert!((p[ch] as i16 - q[ch] as i16).abs() <= 1);
			}
		}
	}

	#[test]
	fn contrast_minus_one_flattens_to_midgray() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([0, 255, 128, 255]));
		let out = apply_contrast(img, -1.0);
		let p = out.get_pixel(0, 0);
		for ch in 0..3 {
			assert!((p[ch] as i16 - 128).abs() <= 1);
		}
	}

	#[test]
	fn hue_zero_offset_is_noop() {
		let img = make_test_image();
		let out = apply_hue(img.clone(), 0.0);
		assert_eq!(out.get_pixel(1, 1), img.get_pixel(1, 1));
	}

	#[test]
	fn hue_full_rotation_returns_original() {
		let img = make_test_image();
		let out = apply_hue(img.clone(), 360.0);
		for (x, y, p) in img.enumerate_pixels() {
			let q = out.get_pixel(x, y);
			for ch in 0..3 {
				assert!((p[ch] as i16 - q[ch] as i16).abs() <= 1);
			}
		}
	}

	#[test]
	fn saturation_negative_desaturates_red() {
		let mut img = RgbaImage::new(1, 1);
		img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
		let out = apply_saturation(img, -0.5);
		let p = out.get_pixel(0, 0);
		assert!(p[0] < 255);
		assert!(p[1] > 0);
		assert!(p[2] > 0);
	}

	#[test]
	fn hsl_roundtrip_midtone() {
		let (h, s, l) = rgb_to_hsl(100, 150, 200);
		let (r, g, b) = hsl_to_rgb(h, s, l);
		assert!((r as i16 - 100).abs() <= 1);
		assert!((g as i16 - 150).abs() <= 1);
		assert!((b as i16 - 200).abs() <= 1);
	}
}

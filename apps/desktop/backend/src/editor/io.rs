// SPDX-License-Identifier: AGPL-3.0-or-later
//! Image I/O for the editor. These are re-exports of the canonical
//! `crate::image_io` module so there's a single loader/saver/resizer across the
//! editor and the plugins (the 3D Texturing tools, Automations). `image_io`
//! adds EXR/TGA on top of what the editor needs; the editor's own
//! `SUPPORTED_EXTS` gate keeps unsupported inputs out regardless.

pub use crate::image_io::{load_dynamic_image, maybe_resize, save_image};

#[cfg(test)]
mod tests {
	use super::*;
	use image::{DynamicImage, GenericImageView};

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

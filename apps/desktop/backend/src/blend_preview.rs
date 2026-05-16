// SPDX-License-Identifier: AGPL-3.0-or-later
//! Parser for Blender's embedded `.blend` preview image. Blender writes a
//! 128×128 BGRA snapshot into a `TEST` block near the start of every saved
//! file when *Save Preview Images* is enabled (default since 2.83). We can
//! read that out without a Blender install — far cheaper than rendering a
//! `.blend` ourselves (Three.js has no loader, and shelling out to a
//! headless Blender is heavy and dependency-fragile).
//!
//! File layout we walk:
//! * 12-byte header: `BLENDER` magic, pointer-size byte (`_` = 4-byte
//!   pointers, `-` = 8-byte), endianness byte (`v` = little, `V` = big),
//!   3-digit version (ignored).
//! * Repeated blocks. Each block header is `code[4]`, `len: i32`, then an
//!   old-pointer field (4 or 8 bytes), `sdna_index: i32`, `count: i32`.
//!   Followed by `len` bytes of block-specific data. We only care about
//!   `TEST`; everything else we seek past. The list ends at `ENDB`.
//! * The `TEST` block's payload starts with two `i32` dimensions (width,
//!   height), then `width * height * 4` bytes of BGRA pixels stored
//!   bottom-row-first (OpenGL framebuffer convention). We swizzle to RGBA
//!   and flip vertically on the way out.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const MAX_PREVIEW_DIM: u32 = 1024;

/// Returns `Ok(Some((width, height, rgba_bytes)))` if the file contains an
/// embedded preview we successfully decoded; `Ok(None)` if no preview was
/// found (no `TEST` block, or the user saved without preview images);
/// `Err` only for I/O errors that prevent us from reading the file at all.
pub fn extract_preview_rgba(path: &Path) -> std::io::Result<Option<(u32, u32, Vec<u8>)>> {
	let file = File::open(path)?;
	let mut reader = BufReader::new(file);

	let mut header = [0u8; 12];
	if reader.read(&mut header)? < 12 {
		return Ok(None);
	}
	if &header[0..7] != b"BLENDER" {
		return Ok(None);
	}
	let pointer_size: usize = if header[7] == b'-' { 8 } else { 4 };
	let big_endian = header[8] == b'V';

	let read_i32 = |buf: [u8; 4]| -> i32 {
		if big_endian {
			i32::from_be_bytes(buf)
		} else {
			i32::from_le_bytes(buf)
		}
	};

	let block_header_size = 4 + 4 + pointer_size + 4 + 4;
	let mut hdr = vec![0u8; block_header_size];

	loop {
		if reader.read_exact(&mut hdr).is_err() {
			return Ok(None);
		}
		let code = &hdr[0..4];
		let len_bytes: [u8; 4] = hdr[4..8].try_into().unwrap();
		let len_i32 = read_i32(len_bytes);
		if len_i32 < 0 {
			return Ok(None);
		}
		let len = len_i32 as usize;

		if code == b"ENDB" {
			return Ok(None);
		}

		if code == b"TEST" {
			let mut data = vec![0u8; len];
			reader.read_exact(&mut data)?;
			if data.len() < 8 {
				return Ok(None);
			}
			let w_i32 = read_i32(data[0..4].try_into().unwrap());
			let h_i32 = read_i32(data[4..8].try_into().unwrap());
			if w_i32 <= 0 || h_i32 <= 0 {
				return Ok(None);
			}
			let w = w_i32 as u32;
			let h = h_i32 as u32;
			if w > MAX_PREVIEW_DIM || h > MAX_PREVIEW_DIM {
				return Ok(None);
			}

			let pixel_bytes = (w as usize) * (h as usize) * 4;
			if data.len() < 8 + pixel_bytes {
				return Ok(None);
			}

			// Swizzle BGRA → RGBA and flip rows so the saved image is
			// top-row-first (PNG convention).
			let row_bytes = (w as usize) * 4;
			let mut rgba = vec![0u8; pixel_bytes];
			for y in 0..(h as usize) {
				let src_row = (h as usize) - 1 - y;
				let src_off = 8 + src_row * row_bytes;
				let dst_off = y * row_bytes;
				for x in 0..(w as usize) {
					let px = src_off + x * 4;
					let dst = dst_off + x * 4;
					rgba[dst] = data[px + 2]; // R
					rgba[dst + 1] = data[px + 1]; // G
					rgba[dst + 2] = data[px]; // B
					rgba[dst + 3] = data[px + 3]; // A
				}
			}
			return Ok(Some((w, h, rgba)));
		}

		// Not the block we want. Seek past its payload to the next header.
		reader.seek(SeekFrom::Current(len as i64))?;
	}
}

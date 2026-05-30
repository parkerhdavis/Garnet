// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared types for the 3D Texturing plugin's tools. Mirror the Rust shapes in
//! `backend/src/image_io.rs` and `backend/src/texturing/`.

export interface ImageInfo {
	width: number;
	height: number;
	channels: number;
	format: string;
	bit_depth: number;
	file_size: number;
}

export interface ImageWithPreview {
	info: ImageInfo;
	preview: string;
}

export interface DirEntry {
	name: string;
	path: string;
	is_dir: boolean;
}

/// Source for a packed/swizzled channel: a real channel or computed luminance.
export type ChannelSource = "r" | "g" | "b" | "a" | "luminance";

/// Map a ChannelSource to the backend's u8 index (0=R..3=A, 4=Luminance).
export function channelSourceToIndex(ch: ChannelSource): number {
	switch (ch) {
		case "r":
			return 0;
		case "g":
			return 1;
		case "b":
			return 2;
		case "a":
			return 3;
		default:
			return 4;
	}
}

/// Export formats supported by the texturing tools' save/export commands.
export type ExportFormat = "png8" | "png16" | "tga" | "jpeg" | "exr";

export interface ExportConfig {
	format: ExportFormat;
	directory: string;
	filename: string;
}

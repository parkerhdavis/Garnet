// SPDX-License-Identifier: AGPL-3.0-or-later
//! The file extensions Garnet can actually *preview/edit inline* — a narrower,
//! more conservative set than the catalog's type-categorization lists in
//! `typeFilters.ts` (which classify any extension for browsing, even ones we
//! can't render). These gate which preview surface the detail page mounts and
//! seed the file filters for the ad-hoc "Open file…" picker.
//!
//! Lowercased, no leading dot — matching `Asset.format`.

/// Video formats with an inline `<video>` preview.
export const VIDEO_EXTS = new Set([
	"mp4",
	"mov",
	"mkv",
	"avi",
	"webm",
	"m4v",
	"wmv",
]);

/// Video formats the editor can round-trip (ffmpeg reads them all). Currently
/// the full `VIDEO_EXTS` set; kept as a distinct constant so the editability
/// gate can diverge from the previewability gate later if needed.
export const VIDEO_EDITABLE_EXTS = VIDEO_EXTS;

/// Audio formats with an inline `<audio>` preview.
export const AUDIO_EXTS = new Set([
	"mp3",
	"wav",
	"flac",
	"ogg",
	"aiff",
	"m4a",
	"opus",
]);

/// Raster + vector formats the `<img>` preview can display.
export const RASTER_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"tif",
	"tiff",
	"webp",
	"avif",
	"svg",
	"ico",
]);

/// Subset of RASTER_EXTS the editor can actually round-trip today
/// (no AVIF/SVG/ICO yet — they need format-specific decoders).
export const EDITABLE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"tif",
	"tiff",
	"webp",
]);

/// 3D model formats the Three.js-backed ModelPreview can load.
export const MODEL_EXTS = new Set([
	"gltf",
	"glb",
	"obj",
	"stl",
	"ply",
	"fbx",
	"usd",
	"usda",
	"usdc",
	"usdz",
]);

/// `.blend` — no interactive renderer; previewed via its embedded thumbnail.
export const BLEND_EXTS = new Set(["blend"]);

/// Every extension that has *some* preview surface, deduped. Drives the
/// "All media" group in the open-file dialog.
export function allPreviewableExts(): string[] {
	return [
		...VIDEO_EXTS,
		...AUDIO_EXTS,
		...RASTER_EXTS,
		...MODEL_EXTS,
		...BLEND_EXTS,
	];
}

/// File-dialog filter groups for the ad-hoc "Open file…" picker. The "All
/// media" group is first so it's the default selection.
export function openFileDialogFilters(): {
	name: string;
	extensions: string[];
}[] {
	return [
		{ name: "All media", extensions: allPreviewableExts() },
		{ name: "Images", extensions: [...RASTER_EXTS] },
		{ name: "Video", extensions: [...VIDEO_EXTS] },
		{ name: "Audio", extensions: [...AUDIO_EXTS] },
		{ name: "3D models", extensions: [...MODEL_EXTS, ...BLEND_EXTS] },
	];
}

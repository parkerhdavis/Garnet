// SPDX-License-Identifier: AGPL-3.0-or-later
//! Maps the sidebar "Types" nav items to file-extension sets. The library is
//! a flat index over file extensions (lowercased, no leading dot); type views
//! are just pre-built format filters on top of that.
//!
//! Animated raster formats (GIF, APNG, animated WebP) are genuinely ambiguous
//! — image/gif by MIME, but most GIFs in the wild are animations. The user
//! chooses where they live via the General settings toggle (see prefsStore).

export const TYPE_KINDS = [
	"images",
	"videos",
	"audio",
	"models",
	"animations",
	"other",
] as const;
export type TypeKind = (typeof TYPE_KINDS)[number];

export function parseTypeKind(value: string | undefined): TypeKind | null {
	if (!value) return null;
	return (TYPE_KINDS as readonly string[]).includes(value) ? (value as TypeKind) : null;
}

/// Static raster + vector image formats — never animated.
const STATIC_IMAGE_FORMATS = [
	"jpg", "jpeg", "jfif", "png", "bmp", "tif", "tiff", "heic", "heif", "avif",
	"svg", "ico", "psd", "ai", "eps", "xcf",
	// Camera raw
	"raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf", "srw", "pef",
];

/// Animated raster formats. Membership in Images vs Animations is configurable.
const AMBIGUOUS_ANIMATED_FORMATS = ["gif", "apng", "webp"];

/// Formats that are unambiguously animation-specific (vector/scene-based, not
/// raster images that happen to animate).
const ANIMATION_ONLY_FORMATS = ["lottie", "riv", "spine", "bvh", "swf", "anim"];

const VIDEO_FORMATS = [
	"mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v",
	"mpg", "mpeg", "3gp", "vob", "mts", "m2ts", "ogv", "ts",
];

const AUDIO_FORMATS = [
	"mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus", "wma",
	"aif", "aiff", "ape", "ac3", "mid", "midi",
];

const MODEL_FORMATS = [
	"obj", "fbx", "gltf", "glb", "dae", "blend", "3ds", "stl", "ply",
	"usd", "usdz", "usda", "usdc", "abc", "x3d", "ma", "mb", "c4d", "max",
	"skp", "lwo", "lws",
];

export type AnimatedImagesBucket = "images" | "animations";

/// Returns the format list for a given type kind, given where ambiguous
/// animated rasters (GIF/APNG/animated WebP) are configured to live.
function formatsForKind(kind: Exclude<TypeKind, "other">, bucket: AnimatedImagesBucket): string[] {
	switch (kind) {
		case "images":
			return bucket === "images"
				? [...STATIC_IMAGE_FORMATS, ...AMBIGUOUS_ANIMATED_FORMATS]
				: STATIC_IMAGE_FORMATS;
		case "animations":
			return bucket === "animations"
				? [...AMBIGUOUS_ANIMATED_FORMATS, ...ANIMATION_ONLY_FORMATS]
				: ANIMATION_ONLY_FORMATS;
		case "videos":
			return VIDEO_FORMATS;
		case "audio":
			return AUDIO_FORMATS;
		case "models":
			return MODEL_FORMATS;
	}
}

/// Union of every categorized extension across all non-"other" kinds. This is
/// the exclude-list passed to the backend when viewing /types/other.
export function allCategorizedFormats(bucket: AnimatedImagesBucket): string[] {
	const kinds: Exclude<TypeKind, "other">[] = [
		"images", "videos", "audio", "models", "animations",
	];
	const set = new Set<string>();
	for (const k of kinds) {
		for (const f of formatsForKind(k, bucket)) set.add(f);
	}
	return [...set];
}

/// Compute the formats/formats_exclude filter for a given type kind. The
/// caller passes the user's manual format selection (FilterBar checkboxes);
/// the type filter ANDs with it.
///
/// - kind=null: no type filter; pass the user's formats through.
/// - kind=other: exclude every categorized format. If the user has also
///   selected explicit formats, restrict to those that aren't already
///   categorized (typically yields 0 matches — unusual, but correct).
/// - kind=any other: intersect user formats with the kind's formats. Empty
///   user selection means "use the kind's full set".
export type TypeQuery = {
	formats: string[];
	formats_exclude: string[];
	/// Set on the Models view so motion-only files (mesh-less FBX rigs,
	/// etc.) are skipped here and surface under Animations instead.
	exclude_motion_only?: boolean;
	/// Set on the Animations view to additionally include motion-only
	/// model files alongside the vanilla animation formats.
	motion_only_overlay?: string[];
};

export function buildTypeQuery(
	kind: TypeKind | null,
	bucket: AnimatedImagesBucket,
	userFormats: string[],
): TypeQuery {
	if (kind === null) {
		return { formats: userFormats, formats_exclude: [] };
	}
	if (kind === "other") {
		const excludes = allCategorizedFormats(bucket);
		if (userFormats.length === 0) {
			return { formats: [], formats_exclude: excludes };
		}
		const set = new Set(excludes);
		return { formats: userFormats.filter((f) => !set.has(f)), formats_exclude: [] };
	}
	const kindFormats = formatsForKind(kind, bucket);
	const baseFormats =
		userFormats.length === 0
			? kindFormats
			: userFormats.filter((f) => new Set(kindFormats).has(f));

	// Animations also pulls in motion-only model files (Mixamo-style
	// retargeting clips). Models view conversely drops them. The flag
	// lives at the SQL level so totals + pagination stay accurate.
	if (kind === "animations") {
		return {
			formats: baseFormats,
			formats_exclude: [],
			motion_only_overlay: MODEL_FORMATS,
		};
	}
	if (kind === "models") {
		return {
			formats: baseFormats,
			formats_exclude: [],
			exclude_motion_only: true,
		};
	}
	return { formats: baseFormats, formats_exclude: [] };
}

/// Filter a list of format counts down to the ones relevant to the current
/// type view — used by FilterBar to scope its chips to the active type.
export function formatsInKind(
	kind: TypeKind | null,
	bucket: AnimatedImagesBucket,
	format: string | null,
): boolean {
	if (kind === null) return true;
	if (kind === "other") {
		if (format === null) return true;
		return !allCategorizedFormats(bucket).includes(format.toLowerCase());
	}
	if (format === null) return false;
	return formatsForKind(kind, bucket).includes(format.toLowerCase());
}

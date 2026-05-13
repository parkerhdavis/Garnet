// SPDX-License-Identifier: AGPL-3.0-or-later
//! Renders a thumbnail for an Asset: tries `get_thumbnail` on the backend, then
//! falls back to a format-based icon. Image decode happens off the main thread
//! via Tauri; we kick a fetch on mount and show a placeholder until it lands.

import { useEffect, useState } from "react";
import {
	HiOutlinePhoto,
	HiOutlineDocument,
	HiOutlineFilm,
	HiOutlineMusicalNote,
	HiOutlineCube,
	HiOutlineCodeBracket,
} from "react-icons/hi2";
import { api, type Asset } from "@/lib/tauri";

const IMAGE_EXTS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "avif", "ico", "svg",
]);
const VIDEO_EXTS = new Set([
	"mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv",
]);
const AUDIO_EXTS = new Set([
	"mp3", "wav", "flac", "ogg", "aiff", "m4a", "opus",
]);
const MODEL_EXTS = new Set([
	"fbx", "obj", "gltf", "glb", "usd", "usdz", "stl", "blend", "dae", "3ds",
]);
const CODE_EXTS = new Set([
	"json", "xml", "yaml", "yml", "toml", "js", "ts", "tsx", "jsx", "py", "rs",
	"go", "java", "cs", "cpp", "c", "h", "sh", "html", "css", "md",
]);

function fallbackIconFor(format: string | null) {
	if (!format) return HiOutlineDocument;
	const f = format.toLowerCase();
	if (IMAGE_EXTS.has(f)) return HiOutlinePhoto;
	if (VIDEO_EXTS.has(f)) return HiOutlineFilm;
	if (AUDIO_EXTS.has(f)) return HiOutlineMusicalNote;
	if (MODEL_EXTS.has(f)) return HiOutlineCube;
	if (CODE_EXTS.has(f)) return HiOutlineCodeBracket;
	return HiOutlineDocument;
}

function absPathFor(asset: Asset): string {
	// `library_roots.path` is canonical with no trailing slash; assets store
	// the relative path with the platform's native separator. Joining with
	// `/` is fine on macOS/Linux and Windows accepts forward slashes too.
	return `${asset.root_path}/${asset.relative_path}`;
}

type Props = {
	asset: Asset;
	size?: number;
	className?: string;
};

export function AssetThumbnail({ asset, size = 240, className = "" }: Props) {
	const [src, setSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setSrc(null);
		setFailed(false);
		const ext = asset.format?.toLowerCase();
		// Only attempt for raster image formats Rust's `image` crate handles —
		// SVG/AVIF/ICO are recognized by the frontend as images for icon
		// fallback but the backend can't decode them today.
		if (!ext || !["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"].includes(ext)) {
			setFailed(true);
			return;
		}
		api.getThumbnail(absPathFor(asset), asset.mtime, size)
			.then((b64) => {
				if (cancelled) return;
				if (b64) setSrc(`data:image/png;base64,${b64}`);
				else setFailed(true);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [asset.id, asset.mtime, asset.format, size]);

	if (src) {
		return (
			<img
				src={src}
				alt={asset.relative_path}
				className={`object-contain w-full h-full ${className}`}
			/>
		);
	}
	if (failed) {
		const Icon = fallbackIconFor(asset.format);
		return (
			<div
				className={`flex flex-col items-center justify-center text-base-content/40 ${className}`}
			>
				<Icon className="size-12" />
				{asset.format && (
					<span className="mt-1 text-xs uppercase tracking-wide">{asset.format}</span>
				)}
			</div>
		);
	}
	return (
		<div className={`flex items-center justify-center ${className}`}>
			<span className="loading loading-spinner loading-sm opacity-40" />
		</div>
	);
}

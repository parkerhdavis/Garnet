// SPDX-License-Identifier: AGPL-3.0-or-later
//! Renders a thumbnail for an Asset: tries `get_thumbnail` on the backend, then
//! falls back to a format-based icon. For video and animated formats, also
//! supports a `liveOnHover` mode where after a hover delay the static
//! thumbnail is swapped for the live media element (autoplay-muted-loop
//! <video> or <img src=convertFileSrc(...)> for GIFs).

import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
	HiOutlinePhoto,
	HiOutlineDocument,
	HiOutlineFilm,
	HiOutlineMusicalNote,
	HiOutlineCube,
	HiOutlineCodeBracket,
} from "react-icons/hi2";
import { api, type Asset } from "@/lib/tauri";
import { absPathFor } from "@/lib/paths";

const RASTER_EXTS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp",
]);
const ANIMATED_IMAGE_EXTS = new Set(["gif"]);
const VIDEO_EXTS = new Set([
	"mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv",
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

const HOVER_PLAYBACK_DELAY_MS = 600;

function fallbackIconFor(format: string | null) {
	if (!format) return HiOutlineDocument;
	const f = format.toLowerCase();
	if (RASTER_EXTS.has(f) || ["svg", "avif", "ico"].includes(f)) return HiOutlinePhoto;
	if (VIDEO_EXTS.has(f)) return HiOutlineFilm;
	if (AUDIO_EXTS.has(f)) return HiOutlineMusicalNote;
	if (MODEL_EXTS.has(f)) return HiOutlineCube;
	if (CODE_EXTS.has(f)) return HiOutlineCodeBracket;
	return HiOutlineDocument;
}

function isHoverPlayable(format: string | null): "video" | "image" | null {
	if (!format) return null;
	const f = format.toLowerCase();
	if (VIDEO_EXTS.has(f)) return "video";
	if (ANIMATED_IMAGE_EXTS.has(f)) return "image";
	return null;
}

type Props = {
	asset: Asset;
	size?: number;
	className?: string;
	/** When true, hovering over video/animated tiles for ~600ms swaps the
	 * thumbnail for an autoplaying live preview. */
	liveOnHover?: boolean;
};

export function AssetThumbnail({ asset, size = 240, className = "", liveOnHover = false }: Props) {
	const [src, setSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [hovering, setHovering] = useState(false);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSrc(null);
		setFailed(false);
		const ext = asset.format?.toLowerCase();
		if (!ext || !RASTER_EXTS.has(ext)) {
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

	const playable = isHoverPlayable(asset.format);
	const showLive = liveOnHover && hovering && playable !== null;

	const onEnter = () => {
		if (!liveOnHover || playable === null) return;
		if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		hoverTimerRef.current = setTimeout(() => setHovering(true), HOVER_PLAYBACK_DELAY_MS);
	};
	const onLeave = () => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
			hoverTimerRef.current = null;
		}
		setHovering(false);
	};
	useEffect(() => {
		return () => {
			if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		};
	}, []);

	const liveSrc = showLive ? convertFileSrc(absPathFor(asset)) : null;

	const wrapperProps = liveOnHover && playable !== null
		? { onMouseEnter: onEnter, onMouseLeave: onLeave }
		: {};

	let content: React.ReactNode;
	if (showLive && liveSrc) {
		if (playable === "video") {
			content = (
				// biome-ignore lint/a11y/useMediaCaption: thumbnail preview, no captions track available
				<video
					src={liveSrc}
					autoPlay
					muted
					loop
					playsInline
					className="object-contain w-full h-full"
				/>
			);
		} else {
			content = (
				<img
					src={liveSrc}
					alt={asset.relative_path}
					className="object-contain w-full h-full"
				/>
			);
		}
	} else if (src) {
		content = (
			<img
				src={src}
				alt={asset.relative_path}
				className={`object-contain w-full h-full ${className}`}
			/>
		);
	} else if (failed) {
		const Icon = fallbackIconFor(asset.format);
		content = (
			<div
				className={`flex flex-col items-center justify-center text-base-content/40 w-full h-full ${className}`}
			>
				<Icon className="size-12" />
				{asset.format && (
					<span className="mt-1 text-xs uppercase tracking-wide">{asset.format}</span>
				)}
			</div>
		);
	} else {
		content = (
			<div className={`flex items-center justify-center w-full h-full ${className}`}>
				<span className="loading loading-spinner loading-sm opacity-40" />
			</div>
		);
	}

	return (
		<div className="w-full h-full" {...wrapperProps}>
			{content}
		</div>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Renders a thumbnail for an Asset. Resolution order:
//!
//! 1. Raster images (png/jpg/gif/bmp/tiff/webp) → `get_thumbnail` Rust command
//!    (cached on disk at $XDG_CACHE_HOME/garnet/thumbnails/).
//! 2. Videos → same `get_thumbnail` command (ffmpeg subprocess for the frame).
//! 3. Anything else → format-category react-icon (photo/film/music/cube/code/
//!    document).
//!
//! When `liveOnHover` is set, hovering a video or animated-image tile for
//! ~600ms swaps the static thumbnail for an autoplay-muted-loop `<video>` (or
//! `<img>` for GIFs) sourced from the media server. The live element is
//! absolute-positioned inside a relative wrapper so its intrinsic dimensions
//! never get to lay themselves out — vertical / non-standard-aspect clips
//! used to flash stretched for a frame before object-fit clamped them.

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
import { api, mediaUrl, type Asset } from "@/lib/tauri";
import { absPathFor } from "@/lib/paths";
import { loadModelThumbnailer } from "@/lib/loadModelThumbnailer";
import { subscribeThumbnailReady } from "@/lib/thumbnailBus";
import { useBgTasksStore } from "@/stores/bgTasksStore";
import { awaitBootReady } from "@/stores/bootStore";

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
	"fbx", "obj", "gltf", "glb", "usd", "usdz", "stl", "blend", "dae", "3ds", "ply",
]);
/// Subset the frontend's Three.js thumbnailer can render. Other model
/// formats stay on the cube-icon fallback.
const RENDERABLE_MODEL_EXTS = new Set(["gltf", "glb", "obj", "stl", "ply", "fbx"]);
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

	const ext = asset.format?.toLowerCase();
	const isRaster = !!ext && RASTER_EXTS.has(ext);
	const isVideo = !!ext && VIDEO_EXTS.has(ext);
	const isRenderableModel = !!ext && RENDERABLE_MODEL_EXTS.has(ext);

	useEffect(() => {
		let cancelled = false;
		setSrc(null);
		setFailed(false);
		if (!isRaster && !isVideo && !isRenderableModel) {
			setFailed(true);
			return;
		}
		const absPath = absPathFor(asset);
		const taskId = `thumb:${absPath}|${asset.mtime ?? ""}|${size}`;
		const taskKind = isRenderableModel ? "model-thumbnail" : "thumbnail";
		let taskRegistered = false;
		const registerTask = () => {
			if (taskRegistered) return;
			taskRegistered = true;
			useBgTasksStore.getState().add({ id: taskId, kind: taskKind });
		};
		const clearTask = () => {
			if (!taskRegistered) return;
			taskRegistered = false;
			useBgTasksStore.getState().remove(taskId);
		};

		// Subscribe FIRST so an event that fires between the cache-miss
		// response and the generation dispatch isn't lost.
		const unsubscribe = subscribeThumbnailReady(
			absPath,
			asset.mtime,
			size,
			(payload) => {
				if (cancelled) return;
				setSrc(convertFileSrc(payload.path));
				setFailed(false);
				clearTask();
			},
		);

		api.getThumbnail(absPath, asset.mtime, size)
			.then(async (path) => {
				if (cancelled) return;
				if (path) {
					// Cache hit. Browser loads the PNG through Tauri's asset
					// protocol — no base64 round trip, decoding happens off
					// the JS main thread.
					setSrc(convertFileSrc(path));
					return;
				}
				// Cache miss. Generation is a *background* task — wait until
				// the splash has finished and the app is settled before
				// firing, so we don't compete with startup work. Detail-page
				// regen and right-click Refresh still bypass this gate.
				await awaitBootReady();
				if (cancelled) return;
				// Image/video go to the Rust async generator; renderable
				// models go to the frontend's Three.js thumbnailer
				// (idle-scheduled, concurrency 1). Both surface their result
				// through `thumbnail:ready` so the subscriber above handles
				// the UI update either way.
				registerTask();
				if (isRenderableModel) {
					try {
						const thumbnailer = await loadModelThumbnailer();
						const ok = await thumbnailer.request(
							absPath,
							asset.mtime,
							size,
							asset.format,
						);
						if (cancelled) return;
						if (!ok) {
							setFailed(true);
							clearTask();
						}
						// On success, the subscriber above already handled
						// setSrc + clearTask via the thumbnail:ready event.
					} catch {
						if (!cancelled) {
							setFailed(true);
							clearTask();
						}
					}
				} else {
					void api.ensureThumbnail(absPath, asset.mtime, size).catch(() => {
						if (!cancelled) setFailed(true);
						clearTask();
					});
				}
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});

		return () => {
			cancelled = true;
			unsubscribe();
			clearTask();
		};
	}, [
		asset.id,
		asset.mtime,
		asset.format,
		asset.relative_path,
		asset.root_path,
		size,
		isRaster,
		isVideo,
		isRenderableModel,
	]);

	const playable = isHoverPlayable(asset.format);
	const showLive = liveOnHover && hovering && playable !== null;

	const [liveSrc, setLiveSrc] = useState<string | null>(null);
	useEffect(() => {
		if (!showLive) {
			setLiveSrc(null);
			return;
		}
		let cancelled = false;
		if (playable === "video") {
			void mediaUrl(absPathFor(asset)).then((u) => {
				if (!cancelled) setLiveSrc(u);
			});
		} else {
			setLiveSrc(convertFileSrc(absPathFor(asset)));
		}
		return () => {
			cancelled = true;
		};
	}, [showLive, playable, asset.id, asset.mtime, asset.relative_path, asset.root_path]);

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

	const wrapperProps = liveOnHover && playable !== null
		? { onMouseEnter: onEnter, onMouseLeave: onLeave }
		: {};

	// Absolute-positioning the media element inside a relative wrapper keeps
	// the wrapper's size authoritative; without this, vertical/non-standard
	// aspect videos briefly render at their intrinsic resolution before
	// object-fit clamps them, producing the visible first-frame "pop".
	const mediaCls = "absolute inset-0 w-full h-full object-contain";

	let content: React.ReactNode;
	if (showLive && liveSrc) {
		if (playable === "video") {
			content = (
				// biome-ignore lint/a11y/useMediaCaption: thumbnail preview, no captions track available
				<video src={liveSrc} autoPlay muted loop playsInline className={mediaCls} />
			);
		} else {
			content = <img src={liveSrc} alt={asset.relative_path} className={mediaCls} />;
		}
	} else if (src) {
		content = (
			<img src={src} alt={asset.relative_path} className={`${mediaCls} ${className}`} />
		);
	} else if (failed) {
		const Icon = fallbackIconFor(asset.format);
		content = (
			<div
				className={`absolute inset-0 flex flex-col items-center justify-center text-base-content/40 ${className}`}
			>
				<Icon className="size-12" />
				{asset.format && (
					<span className="mt-1 text-xs uppercase tracking-wide">{asset.format}</span>
				)}
			</div>
		);
	} else {
		content = (
			<div className={`absolute inset-0 flex items-center justify-center ${className}`}>
				<span className="loading loading-spinner loading-sm opacity-40" />
			</div>
		);
	}

	return (
		<div className="relative w-full h-full" {...wrapperProps}>
			{content}
		</div>
	);
}

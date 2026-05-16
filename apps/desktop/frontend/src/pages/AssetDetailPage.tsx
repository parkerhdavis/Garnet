// SPDX-License-Identifier: AGPL-3.0-or-later
import { lazy, Suspense, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
	HiArrowLeft,
	HiArrowTopRightOnSquare,
	HiFolderOpen,
} from "react-icons/hi2";
import { api, mediaUrl, type Asset, type AssetMetadata } from "@/lib/tauri";
import { MediaDiagnostic } from "@/components/MediaDiagnostic";
import { GarnetMetadataEditor } from "@/components/GarnetMetadataEditor";

// ModelPreview pulls in three.js + addon loaders. Lazy-loading it keeps the
// initial bundle small; the detail page is fast on non-3D assets and Three.js
// only parses once the user actually opens a model.
const ModelPreview = lazy(() =>
	import("@/components/ModelPreview").then((m) => ({ default: m.ModelPreview })),
);
import {
	absPathFor,
	abbreviatePath,
	basename,
	formatSize,
	formatTime,
} from "@/lib/paths";

const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "aiff", "m4a", "opus"]);
const RASTER_EXTS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "avif", "svg", "ico",
]);
const MODEL_EXTS = new Set(["gltf", "glb", "obj", "stl", "ply", "fbx"]);

export function AssetDetailPage() {
	const { id: idParam } = useParams();
	const navigate = useNavigate();
	const [asset, setAsset] = useState<Asset | null>(null);
	const [metadata, setMetadata] = useState<AssetMetadata[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [mediaError, setMediaError] = useState<string | null>(null);
	const [openerError, setOpenerError] = useState<string | null>(null);
	const [diagnosticOpen, setDiagnosticOpen] = useState(false);
	const [livePath, setLivePath] = useState<string>("");

	const ext = asset?.format?.toLowerCase();
	const absPath = asset ? absPathFor(asset) : "";
	const isVideo = !!ext && VIDEO_EXTS.has(ext);
	const isAudio = !!ext && AUDIO_EXTS.has(ext);
	const isImage = !!ext && RASTER_EXTS.has(ext);
	const isModel = !!ext && MODEL_EXTS.has(ext);

	useEffect(() => {
		let cancelled = false;
		const id = Number(idParam);
		if (Number.isNaN(id)) {
			setError("invalid asset id");
			setLoading(false);
			return;
		}
		setLoading(true);
		setMediaError(null);
		Promise.all([api.getAsset(id), api.listAssetMetadata(id)])
			.then(([a, md]) => {
				if (cancelled) return;
				setAsset(a);
				setMetadata(md);
			})
			.catch((e) => {
				if (!cancelled) setError(String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [idParam]);

	useEffect(() => {
		if (!asset) {
			setLivePath("");
			return;
		}
		let cancelled = false;
		if (isVideo || isAudio) {
			void mediaUrl(absPath).then((u) => {
				if (!cancelled) setLivePath(u);
			});
		} else {
			setLivePath(convertFileSrc(absPath));
		}
		return () => {
			cancelled = true;
		};
	}, [asset, absPath, isVideo, isAudio]);


	if (loading) {
		return (
			<div className="flex-1 p-12 text-center text-base-content/60 text-sm">
				Loading…
			</div>
		);
	}
	if (error || !asset) {
		return (
			<div className="flex-1 p-12">
				<div className="alert alert-error max-w-xl mx-auto text-sm">
					<span>{error ?? "Asset not found"}</span>
				</div>
				<div className="text-center mt-4">
					<Link to="/" className="btn btn-sm">
						<HiArrowLeft className="size-4" />
						Back to library
					</Link>
				</div>
			</div>
		);
	}

	const handleOpenExternally = async () => {
		setOpenerError(null);
		try {
			await openPath(absPath);
		} catch (e) {
			setOpenerError(`openPath failed: ${String(e)}`);
		}
	};
	const handleRevealInDir = async () => {
		setOpenerError(null);
		try {
			await revealItemInDir(absPath);
		} catch (e) {
			setOpenerError(`revealItemInDir failed: ${String(e)}`);
		}
	};

	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.22, ease: "easeOut" }}
			className="flex-1 min-h-0 flex flex-col"
		>
			<header className="px-4 py-2.5 border-b border-base-300 bg-base-100 flex items-center gap-2 shrink-0">
				<button
					type="button"
					className="btn btn-xs btn-ghost"
					onClick={() => navigate(-1)}
				>
					<HiArrowLeft className="size-3.5" />
					Back
				</button>
				<div className="min-w-0 flex-1 px-1">
					<h1 className="text-sm font-semibold truncate leading-tight">
						{basename(asset.relative_path)}
					</h1>
					<div
						className="text-[11px] text-base-content/55 font-mono truncate"
						title={absPath}
					>
						{abbreviatePath(asset.root_path)} / {asset.relative_path}
					</div>
				</div>
				<button
					type="button"
					className="btn btn-xs"
					onClick={handleOpenExternally}
					title="Open in the system default application"
				>
					<HiArrowTopRightOnSquare className="size-3.5" />
					Open externally
				</button>
				<button
					type="button"
					className="btn btn-xs btn-ghost"
					onClick={handleRevealInDir}
					title="Reveal in file manager"
				>
					<HiFolderOpen className="size-3.5" />
				</button>
				<button
					type="button"
					className={`btn btn-xs ${diagnosticOpen ? "btn-warning" : "btn-ghost"}`}
					onClick={() => setDiagnosticOpen((v) => !v)}
					title="Toggle media diagnostic panel"
				>
					Diagnose
				</button>
			</header>

			{openerError && (
				<div className="mx-4 mt-3 alert alert-error text-xs">
					<span className="font-mono break-all">{openerError}</span>
				</div>
			)}

			<div className="flex-1 min-h-0 flex">
				<div className="flex-1 min-w-0 flex items-center justify-center bg-base-300/30 p-4">
					{mediaError ? (
						<MediaErrorPanel
							kind={isVideo ? "video" : isAudio ? "audio" : "image"}
							url={livePath}
							absPath={absPath}
							message={mediaError}
						/>
					) : isVideo ? (
						// biome-ignore lint/a11y/useMediaCaption: source content has no caption track
						<video
							src={livePath}
							controls
							onError={(e) => {
								const err = e.currentTarget.error;
								const code = err
									? `MediaError code ${err.code}${err.message ? ": " + err.message : ""}`
									: "no error object";
								setMediaError(
									`The webview rejected this video (${code}). Diagnostic panel below — click Run fetches to probe the asset protocol.`,
								);
								setDiagnosticOpen(true);
							}}
							className="max-w-full max-h-full object-contain bg-black rounded"
						/>
					) : isAudio ? (
						// biome-ignore lint/a11y/useMediaCaption: source content has no caption track
						<audio
							src={livePath}
							controls
							onError={(e) => {
								const err = e.currentTarget.error;
								const code = err
									? `MediaError code ${err.code}${err.message ? ": " + err.message : ""}`
									: "no error object";
								setMediaError(`The webview rejected this audio file (${code}).`);
								setDiagnosticOpen(true);
							}}
							className="w-3/4"
						/>
					) : isImage ? (
						<img
							src={livePath}
							alt={asset.relative_path}
							onError={() =>
								setMediaError(
									"Couldn't load the image — the asset protocol may not be reaching this path. Check that the file is inside HOME / DOCUMENT / DOWNLOAD / DESKTOP.",
								)
							}
							className="max-w-full max-h-full object-contain"
						/>
					) : isModel ? (
						<div className="w-full h-full">
							<Suspense
								fallback={
									<div className="w-full h-full flex items-center justify-center text-xs text-base-content/60">
										Loading 3D viewer…
									</div>
								}
							>
								<ModelPreview url={livePath} format={asset.format} />
							</Suspense>
						</div>
					) : (
						<div className="text-base-content/50 text-sm">
							No inline preview for this format.
						</div>
					)}
				</div>

				<aside className="w-72 shrink-0 border-l border-base-300 bg-base-100 overflow-y-auto">
					<DetailSection title="Details">
						<KV label="Format" value={asset.format ?? "—"} />
						<KV label="Size" value={formatSize(asset.size)} />
						<KV label="Modified" value={formatTime(asset.mtime)} />
						<KV label="Source" value={asset.root_path} mono />
						<KV label="Path" value={asset.relative_path} mono />
					</DetailSection>

					<DetailSection title="Native Metadata">
						{metadata.length === 0 ? (
							<div className="text-xs text-base-content/50">
								No metadata extracted for this format.
							</div>
						) : (
							<dl className="space-y-1 text-xs">
								{metadata.map((m) => (
									<div
										key={`${m.key}-${m.value}`}
										className="grid grid-cols-[1fr_auto] gap-2"
									>
										<dt
											className="font-mono text-[11px] text-base-content/55 truncate"
											title={m.key}
										>
											{m.key}
										</dt>
										<dd className="font-mono text-[11px] truncate" title={m.value}>
											{m.value}
										</dd>
									</div>
								))}
							</dl>
						)}
					</DetailSection>

					<DetailSection title="Garnet Metadata" last>
						<GarnetMetadataEditor assetId={asset.id} />
					</DetailSection>
				</aside>
			</div>

			{diagnosticOpen && (
				<div className="border-t border-warning/40 bg-base-100 max-h-72 overflow-y-auto p-4">
					<MediaDiagnostic url={livePath} absPath={absPath} autoRun />
				</div>
			)}
		</motion.div>
	);
}

function DetailSection({
	title,
	children,
	last,
}: {
	title: string;
	children: React.ReactNode;
	last?: boolean;
}) {
	return (
		<section className={`px-4 py-3 ${last ? "" : "border-b border-base-300"}`}>
			<div className="text-[10px] uppercase tracking-wider text-base-content/45 font-semibold mb-2">
				{title}
			</div>
			{children}
		</section>
	);
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="grid grid-cols-[64px_1fr] gap-2 text-xs py-0.5">
			<dt className="text-base-content/55">{label}</dt>
			<dd className={`truncate ${mono ? "font-mono text-[11px]" : ""}`} title={value}>
				{value}
			</dd>
		</div>
	);
}

function MediaErrorPanel({
	kind,
	url,
	absPath,
	message,
}: {
	kind: "video" | "audio" | "image";
	url: string;
	absPath: string;
	message: string;
}) {
	return (
		<div className="p-6 max-w-2xl text-left">
			<div className="text-sm font-medium mb-2">Couldn't load this {kind}</div>
			<div className="text-xs text-base-content/70 mb-3">{message}</div>
			<div className="text-[10px] font-mono space-y-1 bg-base-300/40 p-2 rounded">
				<div>
					<span className="text-base-content/50">absolute path:</span>{" "}
					<span className="break-all">{absPath}</span>
				</div>
				<div>
					<span className="text-base-content/50">asset url:</span>{" "}
					<span className="break-all">{url}</span>
				</div>
			</div>
			<div className="text-[10px] text-base-content/50 mt-3">
				On Linux, webkit2gtk's <code>&lt;video&gt;</code> element often can't stream
				files through Tauri's asset protocol even when the codec is installed —
				this is a known platform limitation independent of GStreamer codecs. Use{" "}
				<strong>Open externally</strong> in the header to play the file in your
				system's default media app.
			</div>
		</div>
	);
}

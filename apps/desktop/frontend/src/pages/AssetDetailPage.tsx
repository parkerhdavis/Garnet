// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { HiArrowLeft } from "react-icons/hi2";
import { api, type Asset, type AssetMetadata } from "@/lib/tauri";
import { TagEditor } from "@/components/TagEditor";
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

export function AssetDetailPage() {
	const { id: idParam } = useParams();
	const navigate = useNavigate();
	const [asset, setAsset] = useState<Asset | null>(null);
	const [metadata, setMetadata] = useState<AssetMetadata[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [mediaError, setMediaError] = useState<string | null>(null);

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

	if (loading) {
		return (
			<div className="flex-1 p-12 text-center text-base-content/60">Loading…</div>
		);
	}
	if (error || !asset) {
		return (
			<div className="flex-1 p-12">
				<div className="alert alert-error max-w-xl mx-auto">
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

	const ext = asset.format?.toLowerCase();
	const livePath = convertFileSrc(absPathFor(asset));

	const isVideo = !!ext && VIDEO_EXTS.has(ext);
	const isAudio = !!ext && AUDIO_EXTS.has(ext);
	const isImage = !!ext && RASTER_EXTS.has(ext);

	return (
		<div className="flex-1 overflow-auto">
			<div className="max-w-5xl mx-auto p-6 space-y-4">
				<div className="flex items-center gap-3">
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => navigate(-1)}
					>
						<HiArrowLeft className="size-4" />
						Back
					</button>
					<div className="min-w-0">
						<h1 className="text-xl font-semibold truncate">
							{basename(asset.relative_path)}
						</h1>
						<div
							className="text-xs text-base-content/60 font-mono truncate"
							title={absPathFor(asset)}
						>
							{abbreviatePath(asset.root_path)} / {asset.relative_path}
						</div>
					</div>
				</div>

				<div className="card bg-base-100 border border-base-300 overflow-hidden">
					<div className="aspect-video bg-base-200 flex items-center justify-center">
						{mediaError ? (
							<MediaErrorPanel kind={isVideo ? "video" : isAudio ? "audio" : "image"} message={mediaError} />
						) : isVideo ? (
							// biome-ignore lint/a11y/useMediaCaption: source content has no caption track
							<video
								src={livePath}
								controls
								onError={() =>
									setMediaError(
										"Couldn't play this video in the webview. On Linux, MP4/H.264 typically needs gstreamer1.0-libav installed (`sudo apt install gstreamer1.0-libav`).",
									)
								}
								className="w-full h-full object-contain bg-black"
							/>
						) : isAudio ? (
							// biome-ignore lint/a11y/useMediaCaption: source content has no caption track
							<audio
								src={livePath}
								controls
								onError={() => setMediaError("Couldn't play this audio file in the webview.")}
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
								className="w-full h-full object-contain"
							/>
						) : (
							<div className="text-base-content/50">
								No inline preview for this format.
							</div>
						)}
					</div>
				</div>

				<div className="grid md:grid-cols-3 gap-4">
					<div className="card bg-base-100 border border-base-300 md:col-span-1">
						<div className="card-body p-4 text-sm space-y-2">
							<h2 className="card-title text-base">Details</h2>
							<KV label="Format" value={asset.format ?? "—"} />
							<KV label="Size" value={formatSize(asset.size)} />
							<KV label="Modified" value={formatTime(asset.mtime)} />
							<KV label="Source" value={asset.root_path} mono />
							<KV label="Path" value={asset.relative_path} mono />
						</div>
					</div>

					<div className="card bg-base-100 border border-base-300 md:col-span-2">
						<div className="card-body p-4">
							<h2 className="card-title text-base">Tags</h2>
							<TagEditor assetId={asset.id} />

							<h2 className="card-title text-base mt-4">Metadata</h2>
							{metadata.length === 0 ? (
								<div className="text-xs text-base-content/50">
									No metadata extracted.
								</div>
							) : (
								<table className="table table-xs">
									<tbody>
										{metadata.map((m) => (
											<tr key={`${m.key}-${m.value}`}>
												<td className="font-mono text-xs text-base-content/60">
													{m.key}
												</td>
												<td className="font-mono text-xs">{m.value}</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</div>
					</div>
				</div>

				<div className="text-[10px] text-base-content/40 font-mono break-all">
					{absPathFor(asset)}
				</div>
			</div>
		</div>
	);
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="grid grid-cols-[80px_1fr] gap-2 text-xs">
			<dt className="text-base-content/60">{label}</dt>
			<dd className={`truncate ${mono ? "font-mono" : ""}`} title={value}>
				{value}
			</dd>
		</div>
	);
}

function MediaErrorPanel({ kind, message }: { kind: "video" | "audio" | "image"; message: string }) {
	return (
		<div className="p-6 max-w-xl text-center">
			<div className="text-sm font-medium mb-1">Couldn't load this {kind}</div>
			<div className="text-xs text-base-content/70">{message}</div>
		</div>
	);
}

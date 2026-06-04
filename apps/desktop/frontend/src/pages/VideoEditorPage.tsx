// SPDX-License-Identifier: AGPL-3.0-or-later
//! Dedicated video-editor route — the video counterpart of `EditorPage`.
//!
//! The canvas shows a single frame extracted at the playhead (see
//! `videoEditorStore`), with crop / resize / rotate previewed client-side via
//! the shared `EditorCanvas` geometry and color adjustments via a CSS filter —
//! the same approximate-preview / exact-commit split the image editor uses.
//! Trim in/out are set on the timeline below the canvas. Save transcodes the
//! whole op list through ffmpeg in the chosen export format.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { HiArrowLeft, HiCheck, HiNoSymbol } from "react-icons/hi2";
import { confirm } from "@/components/ConfirmDialog";
import CropOverlay, { type CropRect } from "@/components/CropOverlay";
import EditorCanvas from "@/components/EditorCanvas";
import { VideoEditorTools } from "@/components/VideoEditorTools";
import { VideoTimeline } from "@/components/VideoTimeline";
import { api, type Asset } from "@/lib/tauri";
import { absPathFor, basename, dirname } from "@/lib/paths";
import { VIDEO_EDITABLE_EXTS } from "@/lib/previewFormats";
import type { Operation } from "@/stores/editorStore";
import {
	readTrim,
	useVideoEditorStore,
	type VideoOperation,
	withTrim,
} from "@/stores/videoEditorStore";
import { usePrefsStore } from "@/stores/prefsStore";
import { useUndoStore } from "@/stores/undoStore";

/// Export targets. `value` is the format string `commit_video_edit` understands
/// (codec + container); `ext` is the on-disk extension.
const EXPORT_FORMATS: { value: string; label: string; ext: string }[] = [
	{ value: "mp4_h264", label: "MP4 · H.264", ext: "mp4" },
	{ value: "webm_vp9", label: "WebM · VP9", ext: "webm" },
	{ value: "mov_h264", label: "MOV · H.264", ext: "mov" },
	{ value: "mp4_h265", label: "MP4 · H.265 (HEVC)", ext: "mp4" },
	{ value: "gif", label: "GIF", ext: "gif" },
];

function defaultExportFormat(sourceExt: string): string {
	switch (sourceExt.toLowerCase()) {
		case "webm":
			return "webm_vp9";
		case "mov":
			return "mov_h264";
		case "gif":
			return "gif";
		default:
			return "mp4_h264";
	}
}

export function VideoEditorPage() {
	const { id: idParam } = useParams();
	const [searchParams] = useSearchParams();
	const pathParam = searchParams.get("path");
	const ephemeral = pathParam !== null;
	const navigate = useNavigate();

	const [asset, setAsset] = useState<Asset | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [exportFormat, setExportFormat] = useState<string>("mp4_h264");
	const confirmPending = useRef(false);

	const sourcePath = useVideoEditorStore((s) => s.sourcePath);
	const info = useVideoEditorStore((s) => s.info);
	const pendingOps = useVideoEditorStore((s) => s.pendingOps);
	const frameUrl = useVideoEditorStore((s) => s.frameUrl);
	const extracting = useVideoEditorStore((s) => s.extracting);
	const playheadSecs = useVideoEditorStore((s) => s.playheadSecs);
	const playing = useVideoEditorStore((s) => s.playing);
	const dirty = useVideoEditorStore((s) => s.dirty);
	const storeError = useVideoEditorStore((s) => s.error);
	const cropEditMode = useVideoEditorStore((s) => s.cropEditMode);
	const cropEditorInitial = useVideoEditorStore((s) => s.cropEditorInitial);
	const setCropEditMode = useVideoEditorStore((s) => s.setCropEditMode);
	const setOps = useVideoEditorStore((s) => s.setOps);
	const setPlayhead = useVideoEditorStore((s) => s.setPlayhead);
	const togglePlay = useVideoEditorStore((s) => s.togglePlay);
	const load = useVideoEditorStore((s) => s.load);
	const reset = useVideoEditorStore((s) => s.reset);

	const editorSaveDefault = usePrefsStore((s) => s.editorSaveDefault);
	const undoPush = useUndoStore((s) => s.push);
	const clearUndo = useUndoStore((s) => s.clear);

	const absPath = useMemo(() => (asset ? absPathFor(asset) : ""), [asset]);

	// Resolve the asset (catalog id or ephemeral path) and gate on a supported
	// video format.
	useEffect(() => {
		let cancelled = false;
		setLoadError(null);
		const fetchAsset = ephemeral
			? api.describeFile(pathParam as string)
			: Number.isNaN(Number(idParam))
				? Promise.reject(new Error("invalid asset id"))
				: api.getAsset(Number(idParam));
		void fetchAsset
			.then((a) => {
				if (cancelled) return;
				const ext = a.format?.toLowerCase() ?? "";
				if (!VIDEO_EDITABLE_EXTS.has(ext)) {
					setLoadError(`Video editor doesn't support .${ext || "?"} files.`);
					return;
				}
				setExportFormat(defaultExportFormat(ext));
				setAsset(a);
			})
			.catch((e) => {
				if (!cancelled) setLoadError(String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [idParam, pathParam, ephemeral]);

	// Hand the asset to the store; clear the undo stack so Ctrl+Z is scoped to
	// this session.
	useEffect(() => {
		if (!asset) return;
		clearUndo();
		void load(absPath, basename(asset.relative_path));
		return () => {
			reset();
			clearUndo();
		};
	}, [asset, absPath, load, reset, clearUndo]);

	// Trim drag/edit coalescing: a continuous timeline drag fires many
	// onTrimChange calls; snapshot the pre-drag ops once and push a single undo
	// entry after the drag settles.
	const trimBeforeRef = useRef<VideoOperation[] | null>(null);
	const trimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const duration = info?.duration_secs ?? 0;
	const trim = readTrim(pendingOps, duration);

	function handleTrimChange(range: { start: number; end: number }) {
		if (trimBeforeRef.current === null) {
			trimBeforeRef.current = useVideoEditorStore.getState().pendingOps;
		}
		const next = withTrim(
			useVideoEditorStore.getState().pendingOps,
			range,
			duration,
		);
		setOps(next);
		if (trimTimerRef.current) clearTimeout(trimTimerRef.current);
		trimTimerRef.current = setTimeout(() => {
			const before = trimBeforeRef.current;
			trimBeforeRef.current = null;
			trimTimerRef.current = null;
			const after = useVideoEditorStore.getState().pendingOps;
			if (!before || sameOps(before, after)) return;
			undoPush({
				description: "Trim",
				undo: () => setOps(before),
				redo: () => setOps(after),
			});
		}, 400);
	}

	function handleCropDone(rect: CropRect) {
		const before = useVideoEditorStore.getState().pendingOps;
		const withoutCrop = before.filter((o) => o.type !== "crop");
		const next: VideoOperation[] = [
			...withoutCrop,
			{ type: "crop", x: rect.x, y: rect.y, w: rect.w, h: rect.h },
		];
		setOps(next);
		setCropEditMode(false);
		undoPush({
			description: `Crop ${rect.w}×${rect.h} @ ${rect.x},${rect.y}`,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	async function handleSave() {
		if (saving || !sourcePath || !asset || pendingOps.length === 0) return;
		setSaving(true);
		setSavedAt(null);
		try {
			const def =
				EXPORT_FORMATS.find((f) => f.value === exportFormat) ??
				EXPORT_FORMATS[0];
			const { value: format, ext } = def;
			const srcExt = (asset.format ?? "mp4").toLowerCase();
			const base = basename(sourcePath);
			const stem = base.includes(".")
				? base.slice(0, base.lastIndexOf("."))
				: base;
			const dir = dirname(sourcePath);

			let outputPath: string;
			if (editorSaveDefault === "overwrite" && ext === srcExt) {
				outputPath = sourcePath;
			} else if (editorSaveDefault === "overwrite") {
				outputPath = `${dir}/${stem}.${ext}`;
			} else {
				const suggested = `${dir}/${stem}-edited.${ext}`;
				const picked = await saveDialog({
					defaultPath: suggested,
					filters: [{ name: def.label, extensions: [ext] }],
				});
				if (!picked) {
					setSaving(false);
					return;
				}
				outputPath = picked.toLowerCase().endsWith(`.${ext}`)
					? picked
					: `${picked}.${ext}`;
			}
			await api.commitVideoEdit(sourcePath, pendingOps, outputPath, format);
			setSavedAt(new Date().toLocaleTimeString());
		} catch (e) {
			console.error("commit_video_edit failed:", e);
			setLoadError(`Save failed: ${String(e)}`);
		} finally {
			setSaving(false);
		}
	}

	async function handleRevert() {
		if (saving || confirmPending.current) return;
		if (useVideoEditorStore.getState().pendingOps.length === 0) return;
		confirmPending.current = true;
		const ok = await confirm({
			title: "Revert all edits?",
			message: "Discard every pending edit and return to the original video?",
			confirmLabel: "Revert",
			cancelLabel: "Keep editing",
			danger: true,
		});
		confirmPending.current = false;
		if (!ok) return;
		setOps([]);
		clearUndo();
	}

	async function handleExit() {
		if (saving || confirmPending.current) return;
		if (useVideoEditorStore.getState().dirty) {
			confirmPending.current = true;
			const ok = await confirm({
				title: "Discard unsaved edits?",
				message: "You have unsaved changes. Leave the editor and discard them?",
				confirmLabel: "Discard & exit",
				cancelLabel: "Keep editing",
				danger: true,
			});
			confirmPending.current = false;
			if (!ok) return;
		}
		navigate(-1);
	}

	// Set the trim in/out point to the current playhead (the [ and ] shortcuts +
	// the Trim tool's Set in/out). One undo entry per press.
	function setTrimEdge(edge: "in" | "out") {
		const before = useVideoEditorStore.getState().pendingOps;
		const cur = readTrim(before, duration);
		const ph = useVideoEditorStore.getState().playheadSecs;
		const range =
			edge === "in"
				? { start: Math.min(ph, cur.end - 0.05), end: cur.end }
				: { start: cur.start, end: Math.max(ph, cur.start + 0.05) };
		const next = withTrim(before, range, duration);
		if (sameOps(before, next)) return;
		setOps(next);
		undoPush({
			description: edge === "in" ? "Set trim in" : "Set trim out",
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	// Keep the latest handlers in a ref so the global key listener always calls
	// fresh closures without re-subscribing.
	const actionsRef = useRef({
		save: handleSave,
		revert: handleRevert,
		exit: handleExit,
		togglePlay,
		setTrimEdge,
	});
	actionsRef.current = {
		save: handleSave,
		revert: handleRevert,
		exit: handleExit,
		togglePlay,
		setTrimEdge,
	};

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const mod = e.ctrlKey || e.metaKey;
			if (mod && (e.key === "s" || e.key === "S")) {
				e.preventDefault();
				void actionsRef.current.save();
			} else if (mod && (e.key === "r" || e.key === "R")) {
				e.preventDefault();
				void actionsRef.current.revert();
			} else if (e.key === "Escape") {
				if (isTypingTarget(e.target)) return;
				if (useVideoEditorStore.getState().cropEditMode) return;
				e.preventDefault();
				void actionsRef.current.exit();
			} else if (e.key === " " && !mod) {
				// Spacebar toggles playback. Yield to text fields and the crop
				// editor (Space may matter there); otherwise it's play/pause.
				if (isTypingTarget(e.target)) return;
				if (useVideoEditorStore.getState().cropEditMode) return;
				e.preventDefault();
				actionsRef.current.togglePlay();
			} else if (e.key === "[" && !mod) {
				if (isTypingTarget(e.target)) return;
				e.preventDefault();
				actionsRef.current.setTrimEdge("in");
			} else if (e.key === "]" && !mod) {
				if (isTypingTarget(e.target)) return;
				e.preventDefault();
				actionsRef.current.setTrimEdge("out");
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Geometry ops (crop/resize/rotate) reshaped into the image editor's
	// `Operation` shape so the shared EditorCanvas can render them over the
	// frame. The field shapes are identical; only the union differs.
	const geomOps = useMemo<Operation[]>(
		() =>
			pendingOps.flatMap((o): Operation[] => {
				if (o.type === "crop")
					return [{ type: "crop", x: o.x, y: o.y, w: o.w, h: o.h }];
				if (o.type === "resize") return [{ type: "resize", w: o.w, h: o.h }];
				if (o.type === "rotate") return [{ type: "rotate", angle: o.angle }];
				return [];
			}),
		[pendingOps],
	);
	const cssFilter = useMemo(() => videoCssFilter(pendingOps), [pendingOps]);
	const sourceDims = info ? { w: info.width, h: info.height } : null;

	if (loadError) {
		return (
			<div className="flex-1 p-12">
				<div className="alert alert-error max-w-xl mx-auto text-sm">
					<span>{loadError}</span>
				</div>
				<div className="text-center mt-4">
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => navigate(-1)}
					>
						<HiArrowLeft className="size-4" />
						Back
					</button>
				</div>
			</div>
		);
	}

	if (!asset || !info || !frameUrl) {
		return (
			<div className="flex-1 p-12 text-center text-base-content/60 text-sm">
				{storeError ? (
					<span className="text-error">{storeError}</span>
				) : (
					"Loading video…"
				)}
			</div>
		);
	}

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			{saving && (
				<div
					className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-base-300/60 backdrop-blur-[1px] cursor-wait select-none"
					role="status"
					aria-live="polite"
				>
					<span className="loading loading-spinner loading-lg text-primary" />
					<span className="text-sm font-medium text-base-content/80">
						Transcoding… this can take a moment for long clips.
					</span>
				</div>
			)}
			<header className="px-4 py-2.5 border-b border-base-300 bg-base-100 flex items-center gap-2 shrink-0">
				<button
					type="button"
					className="btn btn-xs btn-ghost"
					onClick={handleExit}
					title="Exit editing (Esc)"
				>
					<HiArrowLeft className="size-3.5" />
					Back
				</button>
				<div className="min-w-0 flex-1 px-1">
					<h1 className="text-sm font-semibold truncate leading-tight">
						Editing video — {basename(asset.relative_path)}
					</h1>
					<div className="text-[11px] text-base-content/55 truncate">
						{info.width}×{info.height} ·{" "}
						{info.fps > 0 ? `${info.fps.toFixed(2)} fps · ` : ""}
						{pendingOps.length === 0
							? "no pending edits"
							: `${pendingOps.length} pending edit${pendingOps.length === 1 ? "" : "s"}`}
						{savedAt && (
							<span className="text-success ml-2">· saved {savedAt}</span>
						)}
					</div>
				</div>
				<button
					type="button"
					className="btn btn-xs"
					onClick={handleRevert}
					disabled={pendingOps.length === 0 || saving}
					title="Revert all edits (Ctrl+R)"
				>
					<HiNoSymbol className="size-3.5" />
					Revert
				</button>
				<select
					value={exportFormat}
					onChange={(e) => setExportFormat(e.target.value)}
					disabled={saving}
					className="select select-xs select-bordered"
					title="Export format"
					aria-label="Export format"
				>
					{EXPORT_FORMATS.map((f) => (
						<option key={f.value} value={f.value}>
							{f.label}
						</option>
					))}
				</select>
				<button
					type="button"
					className="btn btn-xs btn-primary"
					onClick={handleSave}
					disabled={!dirty || saving}
					title="Save (Ctrl+S)"
				>
					<HiCheck className="size-3.5" />
					{saving ? "Saving…" : "Save"}
				</button>
			</header>

			<div className="flex-1 min-h-0 flex">
				<div className="flex-1 min-w-0 flex flex-col">
					<div className="flex-1 min-h-0 flex items-center justify-center bg-base-300/30 p-4 relative">
						{cropEditMode && sourceDims ? (
							<CropOverlay
								imgSrc={frameUrl}
								sourceW={sourceDims.w}
								sourceH={sourceDims.h}
								initial={
									cropEditorInitial ??
									(geomOps.find((o) => o.type === "crop") as
										| Extract<Operation, { type: "crop" }>
										| undefined) ??
									null
								}
								cssFilter={cssFilter}
								onDone={handleCropDone}
								onCancel={() => setCropEditMode(false)}
							/>
						) : (
							<EditorCanvas
								imgSrc={frameUrl}
								sourceW={sourceDims?.w ?? 1}
								sourceH={sourceDims?.h ?? 1}
								cssOps={geomOps}
								cssFilter={cssFilter}
							/>
						)}
						{extracting && !cropEditMode && (
							<div className="absolute top-2 right-2 text-[10px] uppercase tracking-wider text-base-content/55 bg-base-100/80 px-2 py-0.5 rounded">
								Extracting frame…
							</div>
						)}
					</div>

					<VideoTimeline
						durationSecs={duration}
						playheadSecs={playheadSecs}
						trim={trim}
						playing={playing}
						onTogglePlay={togglePlay}
						onSeek={setPlayhead}
						onTrimChange={handleTrimChange}
					/>
				</div>

				<VideoEditorTools />
			</div>
		</div>
	);
}

/// Translate the color ops into a CSS `filter:` chain for the live frame
/// preview. Emitted in a FIXED order — brightness → contrast → saturate → hue
/// — regardless of which slider the user touched last, because the backend's
/// ffmpeg color chain applies them in exactly that order; CSS `filter:` is
/// order-sensitive, so a different order here would drift from the saved file.
/// The backend replicates these same W3C operations (in RGB) on commit, so the
/// preview and the output match.
function videoCssFilter(ops: VideoOperation[]): string {
	let brightness = 0;
	let contrast = 0;
	let saturation = 0;
	let hue = 0;
	for (const op of ops) {
		if (op.type === "adjust_brightness") brightness = op.offset;
		else if (op.type === "adjust_contrast") contrast = op.amount;
		else if (op.type === "adjust_saturation") saturation = op.offset;
		else if (op.type === "adjust_hue") hue = op.offset;
	}
	const parts: string[] = [];
	if (brightness !== 0) parts.push(`brightness(${1 + brightness})`);
	if (contrast !== 0) parts.push(`contrast(${1 + contrast})`);
	if (saturation !== 0) parts.push(`saturate(${1 + saturation})`);
	if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
	return parts.join(" ");
}

function isTypingTarget(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	if (!el) return false;
	return (
		el.tagName === "INPUT" ||
		el.tagName === "TEXTAREA" ||
		el.tagName === "SELECT" ||
		el.isContentEditable
	);
}

function sameOps(a: VideoOperation[], b: VideoOperation[]): boolean {
	return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

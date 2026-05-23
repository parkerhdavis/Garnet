// SPDX-License-Identifier: AGPL-3.0-or-later
//! Dedicated image-editor route. Loads an asset by id, mounts the
//! editorStore against its absolute path, and renders the canvas + tools.
//! The canvas swaps between the original (loaded via the asset protocol)
//! and the latest edited preview (base64 PNG from the backend) according
//! to `viewMode`, which the `\` keybind toggles.
//!
//! Save flow lives here too — it reads `editorSaveDefault` from the
//! prefs store to decide between native save-dialog vs. overwrite.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { HiArrowLeft, HiCheck, HiNoSymbol } from "react-icons/hi2";
import CropOverlay, { type CropRect } from "@/components/CropOverlay";
import { EditorTools } from "@/components/EditorTools";
import { api, type Asset } from "@/lib/tauri";
import { absPathFor, basename, dirname } from "@/lib/paths";
import {
	type Operation,
	splitOps,
	useEditorStore,
} from "@/stores/editorStore";
import { usePrefsStore } from "@/stores/prefsStore";
import { useUndoStore } from "@/stores/undoStore";

const SUPPORTED_EXTS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp",
]);

export function EditorPage() {
	const { id: idParam } = useParams();
	const navigate = useNavigate();
	const [asset, setAsset] = useState<Asset | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);

	const sourcePath = useEditorStore((s) => s.sourcePath);
	const previewUrl = useEditorStore((s) => s.previewUrl);
	const previewing = useEditorStore((s) => s.previewing);
	const viewMode = useEditorStore((s) => s.viewMode);
	const setViewMode = useEditorStore((s) => s.setViewMode);
	const cropEditMode = useEditorStore((s) => s.cropEditMode);
	const cropEditorInitial = useEditorStore((s) => s.cropEditorInitial);
	const setCropEditMode = useEditorStore((s) => s.setCropEditMode);
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const setOps = useEditorStore((s) => s.setOps);
	const dirty = useEditorStore((s) => s.dirty);
	const load = useEditorStore((s) => s.load);
	const reset = useEditorStore((s) => s.reset);
	const undoPush = useUndoStore((s) => s.push);

	const editorSaveDefault = usePrefsStore((s) => s.editorSaveDefault);
	const clearUndo = useUndoStore((s) => s.clear);

	const absPath = useMemo(() => (asset ? absPathFor(asset) : ""), [asset]);

	useEffect(() => {
		let cancelled = false;
		const id = Number(idParam);
		if (Number.isNaN(id)) {
			setLoadError("invalid asset id");
			return;
		}
		void api
			.getAsset(id)
			.then((a) => {
				if (cancelled) return;
				const ext = a.format?.toLowerCase() ?? "";
				if (!SUPPORTED_EXTS.has(ext)) {
					setLoadError(`Editor doesn't support .${ext || "?"} files yet.`);
					return;
				}
				setAsset(a);
			})
			.catch((e) => {
				if (!cancelled) setLoadError(String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [idParam]);

	// Hand the asset to the editor store. Clearing the undo stack on entry
	// scopes Ctrl+Z to this session — actions from the library page would
	// otherwise be the first thing undone, which is surprising.
	useEffect(() => {
		if (!asset) return;
		clearUndo();
		void load(absPath, basename(asset.relative_path));
		return () => {
			reset();
			clearUndo();
		};
	}, [asset, absPath, load, reset, clearUndo]);

	// Capture the original image's dimensions once it loads. Used by the
	// crop / resize / corner-round tools to seed sensible defaults.
	useEffect(() => {
		if (!absPath) {
			setSourceDims(null);
			return;
		}
		const img = new Image();
		img.onload = () => setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
		img.src = convertFileSrc(absPath);
	}, [absPath]);

	// `\` peek/toggle. Hold = peek original while down; tap (no movement)
	// toggles edited/original. We treat any keyup within ~250ms of keydown
	// with no intervening "actual hold" usage as a tap.
	useEffect(() => {
		let downAt: number | null = null;
		let peeking = false;
		function isEditable(t: EventTarget | null) {
			const el = t as HTMLElement | null;
			if (!el) return false;
			if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
			return el.isContentEditable;
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "\\" || e.repeat) return;
			if (isEditable(e.target)) return;
			e.preventDefault();
			downAt = performance.now();
			// Begin peek immediately — if the user releases inside the tap
			// window, we'll treat it as a toggle and restore the previous mode.
			peeking = useEditorStore.getState().viewMode === "edited";
			if (peeking) setViewMode("original");
		}
		function onKeyUp(e: KeyboardEvent) {
			if (e.key !== "\\") return;
			if (isEditable(e.target)) return;
			e.preventDefault();
			const held = downAt === null ? 0 : performance.now() - downAt;
			downAt = null;
			if (held < 250) {
				// Tap: flip mode (and undo the peek if we engaged it).
				const current = useEditorStore.getState().viewMode;
				if (peeking) {
					// We auto-peeked to original on keydown; tap should
					// toggle relative to the *pre-peek* mode, which was edited.
					setViewMode(current === "original" ? "edited" : "original");
				} else {
					setViewMode(current === "original" ? "edited" : "original");
				}
			} else {
				// Hold: release returns to edited regardless of peeking flag.
				setViewMode("edited");
			}
			peeking = false;
		}
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
		};
	}, [setViewMode]);

	async function handleSave() {
		if (!sourcePath || !asset || pendingOps.length === 0) return;
		setSaving(true);
		setSavedAt(null);
		try {
			let outputPath: string;
			let format: string;
			const ext = (asset.format ?? "png").toLowerCase();
			if (editorSaveDefault === "overwrite") {
				outputPath = sourcePath;
				format = normalizeFormat(ext);
			} else {
				const base = basename(sourcePath);
				const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
				const dir = dirname(sourcePath);
				const suggested = `${dir}/${stem}-edited.${ext}`;
				const picked = await saveDialog({
					defaultPath: suggested,
					filters: [{ name: "Image", extensions: Array.from(SUPPORTED_EXTS) }],
				});
				if (!picked) {
					setSaving(false);
					return;
				}
				outputPath = picked;
				const pickedExt = picked.includes(".") ? picked.slice(picked.lastIndexOf(".") + 1) : ext;
				format = normalizeFormat(pickedExt);
			}
			await invoke<void>("commit_edit", {
				path: sourcePath,
				ops: pendingOps,
				outputPath,
				format,
			});
			setSavedAt(new Date().toLocaleTimeString());
		} catch (e) {
			console.error("commit_edit failed:", e);
			setLoadError(`Save failed: ${String(e)}`);
		} finally {
			setSaving(false);
		}
	}

	function handleRevert() {
		if (pendingOps.length === 0) return;
		void useEditorStore.getState().setOps([]);
		clearUndo();
	}

	function handleCropDone(rect: CropRect) {
		const before = useEditorStore.getState().pendingOps;
		// Replace any existing crop op (keep it as the last in the pipeline
		// so it composes after upstream client-side ops).
		const withoutCrop = before.filter((o) => o.type !== "crop");
		const next: Operation[] = [
			...withoutCrop,
			{ type: "crop", x: rect.x, y: rect.y, w: rect.w, h: rect.h },
		];
		void setOps(next);
		setCropEditMode(false);
		undoPush({
			description: `Crop ${rect.w}×${rect.h} @ ${rect.x},${rect.y}`,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	function handleCropCancel() {
		setCropEditMode(false);
	}

	// Derive view state up here — these must run on every render to
	// satisfy React's hook-ordering rule, even when an early-return
	// branch below skips the canvas.
	const showingOriginal = viewMode === "original";
	const originalSrc = asset ? convertFileSrc(absPath) : "";
	const { backendOps, cssOps } = useMemo(() => splitOps(pendingOps), [pendingOps]);
	const curveLut = useMemo(() => lastLutIn(cssOps), [cssOps]);
	const wbScale = useMemo(() => accumulateWhiteBalance(cssOps), [cssOps]);
	const cropOp = useMemo(
		() =>
			cssOps.find((o) => o.type === "crop") as
				| Extract<Operation, { type: "crop" }>
				| undefined,
		[cssOps],
	);
	// Filters that apply to the canvas img. When in crop-edit mode the
	// committed crop is hidden so the user can re-select the rect, but
	// other adjustments stay visible.
	const cssFilter = useMemo(
		() =>
			showingOriginal
				? ""
				: cssFilterFor(
						cssOps,
						curveLut ? CURVE_FILTER_ID : null,
						wbScale ? WB_FILTER_ID : null,
					),
		[cssOps, curveLut, wbScale, showingOriginal],
	);
	const usingBackendPreview = !showingOriginal && backendOps.length > 0;
	const canvasSrc = showingOriginal
		? originalSrc
		: usingBackendPreview
			? (previewUrl ?? originalSrc)
			: originalSrc;
	const showCrop = !showingOriginal && !cropEditMode && cropOp !== undefined;

	const filterDefs =
		curveLut || wbScale ? (
			<svg
				aria-hidden
				width={0}
				height={0}
				style={{ position: "absolute", width: 0, height: 0 }}
			>
				<defs>
					{curveLut && (
						<filter id={CURVE_FILTER_ID} colorInterpolationFilters="sRGB">
							<feComponentTransfer>
								<feFuncR type="table" tableValues={lutToTableValues(curveLut)} />
								<feFuncG type="table" tableValues={lutToTableValues(curveLut)} />
								<feFuncB type="table" tableValues={lutToTableValues(curveLut)} />
							</feComponentTransfer>
						</filter>
					)}
					{wbScale && (
						<filter id={WB_FILTER_ID} colorInterpolationFilters="sRGB">
							<feColorMatrix
								type="matrix"
								values={`${wbScale.r} 0 0 0 0  0 ${wbScale.g} 0 0 0  0 0 ${wbScale.b} 0 0  0 0 0 1 0`}
							/>
						</filter>
					)}
				</defs>
			</svg>
		) : null;

	if (loadError) {
		return (
			<div className="flex-1 p-12">
				<div className="alert alert-error max-w-xl mx-auto text-sm">
					<span>{loadError}</span>
				</div>
				<div className="text-center mt-4">
					<button type="button" className="btn btn-sm" onClick={() => navigate(-1)}>
						<HiArrowLeft className="size-4" />
						Back
					</button>
				</div>
			</div>
		);
	}

	if (!asset) {
		return (
			<div className="flex-1 p-12 text-center text-base-content/60 text-sm">Loading…</div>
		);
	}

	// canvasSrc semantics:
	//   - peek/toggle original  → originalSrc, no filter
	//   - no transforms in pipeline → originalSrc + CSS filter (real-time)
	//   - has transforms, preview ready → previewUrl + CSS filter (overlay)
	//   - has transforms, preview rendering → fall back to originalSrc so
	//     the canvas isn't empty during the round-trip

	return (
		<div className="flex-1 min-h-0 flex flex-col">
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
						Editing — {basename(asset.relative_path)}
					</h1>
					<div className="text-[11px] text-base-content/55 truncate">
						{pendingOps.length === 0 ? (
							"no pending edits"
						) : (
							<>
								{pendingOps.length} pending edit{pendingOps.length === 1 ? "" : "s"}
								{savedAt && <span className="text-success ml-2">· saved {savedAt}</span>}
							</>
						)}
					</div>
				</div>
				<span className="badge badge-xs badge-ghost" title="Hold \\ to peek original; tap \\ to toggle">
					{showingOriginal ? "Original" : "Edited"}
				</span>
				<button
					type="button"
					className="btn btn-xs"
					onClick={handleRevert}
					disabled={pendingOps.length === 0 || saving}
				>
					<HiNoSymbol className="size-3.5" />
					Revert
				</button>
				<button
					type="button"
					className="btn btn-xs btn-primary"
					onClick={handleSave}
					disabled={!dirty || saving}
				>
					<HiCheck className="size-3.5" />
					{saving ? "Saving…" : "Save"}
				</button>
			</header>

			<div className="flex-1 min-h-0 flex">
				<div className="flex-1 min-w-0 flex items-center justify-center bg-base-300/30 p-4 relative">
					{/* Inline SVG filters for ops without a built-in CSS primitive:
					    luminance curve as <feComponentTransfer>, white-balance
					    temp+tint combined as a single channel-scale
					    <feColorMatrix>. Both stay on the GPU at full resolution. */}
					{filterDefs}
					{cropEditMode && sourceDims ? (
						<CropOverlay
							imgSrc={canvasSrc}
							sourceW={sourceDims.w}
							sourceH={sourceDims.h}
							initial={
								// Preset override > existing crop op > full image.
								cropEditorInitial ??
								(cropOp
									? { x: cropOp.x, y: cropOp.y, w: cropOp.w, h: cropOp.h }
									: null)
							}
							cssFilter={cssFilter}
							onDone={handleCropDone}
							onCancel={handleCropCancel}
						/>
					) : showCrop && cropOp && sourceDims ? (
						// Client-side crop preview: the container is sized to
						// the crop's aspect ratio (max-w/max-h capped) and the
						// img is scaled+positioned so only the crop rect is
						// visible. No backend round-trip, no PNG re-encode,
						// no color shift.
						<div
							className="max-w-full max-h-full overflow-hidden relative"
							style={{
								aspectRatio: `${cropOp.w} / ${cropOp.h}`,
								// Match the un-cropped layout: prefer width but
								// stay bounded by available height.
								width: `min(100%, calc((100vh - 12rem) * ${cropOp.w / cropOp.h}))`,
							}}
						>
							<img
								src={canvasSrc}
								alt="Edited preview"
								className="absolute top-0 left-0"
								style={{
									width: `${(sourceDims.w / cropOp.w) * 100}%`,
									height: `${(sourceDims.h / cropOp.h) * 100}%`,
									left: `${(-cropOp.x / cropOp.w) * 100}%`,
									top: `${(-cropOp.y / cropOp.h) * 100}%`,
									maxWidth: "none",
									maxHeight: "none",
									filter: cssFilter || undefined,
								}}
							/>
						</div>
					) : (
						<img
							src={canvasSrc}
							alt={showingOriginal ? "Original" : "Edited preview"}
							className="max-w-full max-h-full object-contain"
							style={cssFilter ? { filter: cssFilter } : undefined}
						/>
					)}
					{previewing && usingBackendPreview && !cropEditMode && (
						<div className="absolute top-2 right-2 text-[10px] uppercase tracking-wider text-base-content/55 bg-base-100/80 px-2 py-0.5 rounded">
							Rendering transforms…
						</div>
					)}
				</div>

				<EditorTools sourceDims={sourceDims} />
			</div>
		</div>
	);
}

function normalizeFormat(ext: string): string {
	const e = ext.toLowerCase();
	if (e === "jpeg") return "jpg";
	if (e === "tif") return "tiff";
	return e;
}

const CURVE_FILTER_ID = "garnet-curve-lut";
const WB_FILTER_ID = "garnet-wb-scale";

/// Sensitivity factor matched to the backend's `apply_temperature` /
/// `apply_tint` math so the live preview tracks what the commit pipeline
/// will produce.
const WB_K = 0.3;

/// Translate the CSS-representable subset of adjust ops into a `filter:`
/// chain. The math doesn't match the Rust pipeline exactly (CSS uses a
/// matrix-based hue rotation; ours is HSL-based), but it's close enough
/// for live preview — commit uses the exact Rust math, so what gets
/// written to disk always matches the operation spec, not the CSS
/// approximation.
///
/// `lutFilterId` and `wbFilterId`, when non-null, are appended as
/// `url(#id)` so their inline SVG filters apply on the GPU.
function cssFilterFor(
	ops: Operation[],
	lutFilterId: string | null,
	wbFilterId: string | null,
): string {
	const parts: string[] = [];
	for (const op of ops) {
		switch (op.type) {
			case "adjust_hue":
				if (op.offset !== 0) parts.push(`hue-rotate(${op.offset}deg)`);
				break;
			case "adjust_saturation":
				if (op.offset !== 0) parts.push(`saturate(${1 + op.offset})`);
				break;
			case "adjust_brightness":
				if (op.offset !== 0) parts.push(`brightness(${1 + op.offset})`);
				break;
			case "adjust_contrast":
				if (op.amount !== 0) parts.push(`contrast(${1 + op.amount})`);
				break;
			// luminance_curve, adjust_temperature, adjust_tint are handled
			// via their respective SVG filters below.
		}
	}
	if (lutFilterId) parts.push(`url(#${lutFilterId})`);
	if (wbFilterId) parts.push(`url(#${wbFilterId})`);
	return parts.join(" ");
}

/// Fold all temperature + tint ops in the CSS slice into a single set
/// of R/G/B channel multipliers, matching the backend's math. Returns
/// null when nothing would change (avoids rendering a no-op filter).
function accumulateWhiteBalance(
	ops: Operation[],
): { r: number; g: number; b: number } | null {
	let r = 1;
	let g = 1;
	let b = 1;
	let any = false;
	for (const op of ops) {
		if (op.type === "adjust_temperature" && op.amount !== 0) {
			r *= 1 + WB_K * op.amount;
			b *= 1 - WB_K * op.amount;
			any = true;
		} else if (op.type === "adjust_tint" && op.amount !== 0) {
			g *= 1 - WB_K * op.amount;
			any = true;
		}
	}
	return any ? { r, g, b } : null;
}

/// Find the LUT from the last `luminance_curve` op in the CSS slice, if any.
/// Subsequent CSS-filter primitives in the chain still apply on top of it.
function lastLutIn(ops: Operation[]): number[] | null {
	for (let i = ops.length - 1; i >= 0; i--) {
		if (ops[i].type === "luminance_curve") {
			return (ops[i] as Extract<Operation, { type: "luminance_curve" }>).lut;
		}
	}
	return null;
}

/// SVG feFunc table values are normalized [0,1] space-separated floats.
function lutToTableValues(lut: number[]): string {
	return lut.map((v) => (v / 255).toFixed(4)).join(" ");
}

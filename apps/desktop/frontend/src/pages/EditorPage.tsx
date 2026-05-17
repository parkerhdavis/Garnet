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
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const dirty = useEditorStore((s) => s.dirty);
	const load = useEditorStore((s) => s.load);
	const reset = useEditorStore((s) => s.reset);

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

	// Derive view state up here — these must run on every render to
	// satisfy React's hook-ordering rule, even when an early-return
	// branch below skips the canvas.
	const showingOriginal = viewMode === "original";
	const originalSrc = asset ? convertFileSrc(absPath) : "";
	const { backendOps, cssOps } = useMemo(() => splitOps(pendingOps), [pendingOps]);
	const cssFilter = useMemo(
		() => (showingOriginal ? "" : cssFilterFor(cssOps)),
		[cssOps, showingOriginal],
	);
	const usingBackendPreview = !showingOriginal && backendOps.length > 0;
	const canvasSrc = showingOriginal
		? originalSrc
		: usingBackendPreview
			? (previewUrl ?? originalSrc)
			: originalSrc;

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
					<img
						src={canvasSrc}
						alt={showingOriginal ? "Original" : "Edited preview"}
						className="max-w-full max-h-full object-contain"
						style={cssFilter ? { filter: cssFilter } : undefined}
					/>
					{previewing && usingBackendPreview && (
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

/// Translate the CSS-representable subset of adjust ops into a `filter:`
/// chain. The math doesn't match the Rust pipeline exactly (CSS uses a
/// matrix-based hue rotation; ours is HSL-based), but it's close enough
/// for live preview — commit uses the exact Rust math, so what gets
/// written to disk always matches the operation spec, not the CSS
/// approximation.
function cssFilterFor(ops: Operation[]): string {
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
		}
	}
	return parts.join(" ");
}

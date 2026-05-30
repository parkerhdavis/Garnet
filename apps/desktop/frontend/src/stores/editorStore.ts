// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-asset editor state: the pending operation stack, the latest preview
//! image, and a viewMode flag the canvas reads to choose between original
//! and edited pixels. Edits do not touch disk — they live here until the
//! user commits via the save flow.
//!
//! Why a single global store instead of one per open editor: we only ever
//! have one editor open at a time (it's a dedicated route, not a tabbed
//! workspace). If multi-tab editing arrives later, this becomes a Map
//! keyed by assetId.
//!
//! Each user action pushes one `Operation` and a paired entry into the
//! global undoStore — keeping `pendingOps` and the visible undo history
//! aligned without a second tracking mechanism.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { mediaUrl } from "@/lib/tauri";

/// Mirrors `editor::pipeline::Operation` (snake_case via serde tag).
export type Operation =
	| { type: "adjust_hue"; offset: number }
	| { type: "adjust_saturation"; offset: number }
	| { type: "adjust_brightness"; offset: number }
	| { type: "adjust_contrast"; amount: number }
	| { type: "adjust_temperature"; amount: number }
	| { type: "adjust_tint"; amount: number }
	| { type: "luminance_curve"; lut: number[] }
	| { type: "crop"; x: number; y: number; w: number; h: number }
	| { type: "resize"; w: number; h: number }
	| { type: "rotate"; angle: number }
	| { type: "corner_round"; radius: number };

/// Ops that can be previewed client-side via a CSS `filter:` chain —
/// real time, full resolution, no backend round-trip. Hue/sat/brightness/
/// contrast map onto built-in `filter:` primitives; `luminance_curve`
/// rides the same channel via an inline SVG `<feComponentTransfer>` filter
/// referenced as `filter: url(#…)`.
export function isCssFilterOp(op: Operation): boolean {
	return (
		op.type === "adjust_hue" ||
		op.type === "adjust_saturation" ||
		op.type === "adjust_brightness" ||
		op.type === "adjust_contrast" ||
		op.type === "adjust_temperature" ||
		op.type === "adjust_tint" ||
		op.type === "luminance_curve"
	);
}

/// Ops that the canvas can render without a backend round-trip. The
/// pixel-level adjusts ride a CSS `filter:` chain; the geometric
/// transforms (crop, resize, rotate, corner-round) ride a layered set
/// of wrappers (overflow:hidden + aspect-ratio + transform:rotate +
/// border-radius) computed from the cssOps. Keeping all of them
/// client-side avoids the multi-second backend round-trip and the
/// color-shift from the un-profiled PNG re-encode.
export function isClientPreviewableOp(op: Operation): boolean {
	return (
		isCssFilterOp(op) ||
		op.type === "crop" ||
		op.type === "resize" ||
		op.type === "rotate" ||
		op.type === "corner_round"
	);
}

/// Split the pipeline at the last op that *can't* be previewed in the
/// browser. Backend renders everything up to and including that op;
/// the trailing client-renderable ops (CSS filters + crop) apply on the
/// canvas in real time. When `backendOps` is empty, the canvas can
/// render the original directly with the client overlay on top — the
/// hot path for slider/curve/crop edits, which never touches Rust.
export function splitOps(ops: Operation[]): {
	backendOps: Operation[];
	cssOps: Operation[];
} {
	let lastNonClient = -1;
	for (let i = ops.length - 1; i >= 0; i--) {
		if (!isClientPreviewableOp(ops[i])) {
			lastNonClient = i;
			break;
		}
	}
	if (lastNonClient === -1) return { backendOps: [], cssOps: ops };
	return {
		backendOps: ops.slice(0, lastNonClient + 1),
		cssOps: ops.slice(lastNonClient + 1),
	};
}

function opsEqual(a: Operation[], b: Operation[]): boolean {
	return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

interface EditorState {
	/// Absolute path of the source image. null when no asset is loaded.
	sourcePath: string | null;
	/// Friendly name shown in the header / save dialog default.
	sourceName: string | null;
	/// Ordered list of pending operations — replayed from the original on
	/// every preview/commit. Cleared on `reset` or after a successful save.
	pendingOps: Operation[];
	/// HTTP URL of the latest backend preview (served by the localhost
	/// media server). null when there are no transform/LUT ops to render
	/// — in that case the canvas renders the original directly with the
	/// CSS-filter chain applied on top.
	previewUrl: string | null;
	/// Backend ops the current `previewUrl` corresponds to. Used to skip
	/// the backend round-trip when the user is only tweaking CSS-filter
	/// adjusts that overlay onto an already-rendered transform result.
	lastBackendOps: Operation[];
	/// True while a backend preview round-trip is in flight.
	previewing: boolean;
	/// Set when a fresh preview was requested while one was already in
	/// flight. The handler re-fires `refreshPreview` once the in-flight
	/// call resolves so transforms applied during a render don't get lost.
	previewStale: boolean;
	/// Monotonic generation token, bumped at the start of every
	/// `refreshPreview`. A backend render captures the token before it
	/// awaits and discards its result if the token has since moved on (a
	/// newer edit) or the asset was switched/reset — so a slow or
	/// out-of-order render can never clobber fresher state. (Backend renders
	/// only happen when an op isn't client-previewable, which is none today,
	/// so this is forward-looking insurance, not currently load-bearing.)
	previewToken: number;
	/// True when the canvas should render the original pixels — used by
	/// the `\` peek/toggle keybind. The original is loaded as the initial
	/// preview, so the canvas just stops re-rendering edits while this is on.
	viewMode: "edited" | "original";
	/// True while the user is interactively setting a crop rect. The
	/// canvas swaps to a full-image view with a draggable rect overlay
	/// instead of showing the cropped result.
	cropEditMode: boolean;
	/// Optional initial rect to seed the crop editor with, in image px.
	/// Used by the aspect-ratio presets so the editor opens already
	/// shaped to (e.g.) 16:9 rather than mirroring the existing crop.
	/// Null falls back to the existing crop op, or the full image.
	cropEditorInitial: { x: number; y: number; w: number; h: number } | null;
	/// True after any op has landed; reset on load / save / reset.
	dirty: boolean;

	load: (path: string, name: string) => Promise<void>;
	/// Push or replace an op. If `replaceLastOfType` is true, the last op
	/// with the same `type` is replaced — used by slider drags so each
	/// slider only contributes one entry to the pipeline (and one undo
	/// step) rather than one per frame.
	pushOp: (
		op: Operation,
		opts?: { replaceLastOfType?: boolean },
	) => Promise<void>;
	/// Pop the trailing op (used by undo).
	popOp: () => Promise<void>;
	/// Replace the entire op list (used by redo restoring a full state).
	setOps: (ops: Operation[]) => Promise<void>;
	setViewMode: (mode: "edited" | "original") => void;
	/// Toggle the crop editor. When opening, an optional initial rect
	/// can be passed (e.g. from an aspect-ratio preset); when closing,
	/// the initial override is cleared.
	setCropEditMode: (
		b: boolean,
		initial?: { x: number; y: number; w: number; h: number } | null,
	) => void;
	reset: () => void;
	/// Re-render the preview from the current `pendingOps`. Called
	/// automatically by push/pop/setOps; exposed so the canvas can
	/// request a refresh after viewMode flips.
	refreshPreview: () => Promise<void>;
}

export const useEditorStore = create<EditorState>((set, get) => ({
	sourcePath: null,
	sourceName: null,
	pendingOps: [],
	previewUrl: null,
	lastBackendOps: [],
	previewing: false,
	previewStale: false,
	previewToken: 0,
	viewMode: "edited",
	cropEditMode: false,
	cropEditorInitial: null,
	dirty: false,

	load: async (path, name) => {
		set({
			sourcePath: path,
			sourceName: name,
			pendingOps: [],
			previewUrl: null,
			lastBackendOps: [],
			previewing: false,
			previewStale: false,
			viewMode: "edited",
			cropEditMode: false,
			cropEditorInitial: null,
			dirty: false,
		});
		await get().refreshPreview();
	},

	pushOp: async (op, opts) => {
		const replace = opts?.replaceLastOfType === true;
		const current = get().pendingOps;
		let next: Operation[];
		if (replace) {
			// Replace the last op of the SAME type wherever it sits in the
			// pipeline — not only when it happens to be the trailing element.
			// Slider/curve drags coalesce through here; if the user touched a
			// different tool in between (so a different op is now last), the
			// old "tail only" check appended a duplicate op of this type
			// instead of replacing it, and the duplicates then compounded in
			// the CSS filter chain (the image no longer matched the slider).
			let idx = -1;
			for (let i = current.length - 1; i >= 0; i--) {
				if (current[i].type === op.type) {
					idx = i;
					break;
				}
			}
			if (idx === -1) {
				next = [...current, op];
			} else {
				next = current.slice();
				next[idx] = op;
			}
		} else {
			next = [...current, op];
		}
		set({ pendingOps: next, dirty: true });
		await get().refreshPreview();
	},

	popOp: async () => {
		const current = get().pendingOps;
		if (current.length === 0) return;
		const next = current.slice(0, -1);
		set({ pendingOps: next, dirty: next.length > 0 });
		await get().refreshPreview();
	},

	setOps: async (ops) => {
		set({ pendingOps: ops, dirty: ops.length > 0 });
		await get().refreshPreview();
	},

	setViewMode: (mode) => set({ viewMode: mode }),

	setCropEditMode: (b, initial) =>
		set({
			cropEditMode: b,
			// On open: store the optional initial (may be null = use cropOp).
			// On close: always clear so the next open starts clean.
			cropEditorInitial: b ? (initial ?? null) : null,
		}),

	reset: () =>
		set({
			sourcePath: null,
			sourceName: null,
			pendingOps: [],
			previewUrl: null,
			lastBackendOps: [],
			previewing: false,
			previewStale: false,
			viewMode: "edited",
			cropEditMode: false,
			cropEditorInitial: null,
			dirty: false,
		}),

	refreshPreview: async () => {
		// Bump the generation token first thing. Any backend render already
		// in flight captured an earlier token and will discard its result
		// rather than overwrite the state this (newer) call produces. Cheap:
		// the field isn't subscribed by any component, so this never renders.
		const token = get().previewToken + 1;
		set({ previewToken: token });

		const { sourcePath, pendingOps, previewing, lastBackendOps, previewUrl } =
			get();
		if (!sourcePath) return;
		const { backendOps } = splitOps(pendingOps);
		// All CSS-representable (or empty). The canvas renders the
		// original directly with a `filter:` chain applied — full
		// resolution, real-time, zero backend round-trip.
		if (backendOps.length === 0) {
			set({
				previewUrl: null,
				lastBackendOps: [],
				previewing: false,
				previewStale: false,
			});
			return;
		}
		// CSS-only tweaks while the backend slice is unchanged: the
		// existing `previewUrl` is still correct; the cssOps chain
		// just overlays on top of it. No backend call needed.
		if (previewUrl !== null && opsEqual(backendOps, lastBackendOps)) {
			set({ previewing: false, previewStale: false });
			return;
		}
		// If one is already running, mark stale and bail — the in-flight
		// handler will re-fire once it resolves, picking up whatever
		// the latest backend slice happens to be.
		if (previewing) {
			set({ previewStale: true });
			return;
		}
		set({ previewing: true, previewStale: false });
		try {
			// No size cap — transforms aren't slider-driven, so the
			// one-time full-resolution render cost per transform-apply
			// is fine, and the preview matches the eventual commit.
			const path = await invoke<string>("preview_edit", {
				path: sourcePath,
				ops: backendOps,
				maxPreviewSize: null,
			});
			const url = await mediaUrl(path);
			// Discard if a newer refresh superseded us while we were awaiting
			// — a later edit (token moved on) or an asset switch/reset
			// (sourcePath changed). Writing here would clobber fresher state
			// with a stale (possibly wrong-asset) preview.
			if (get().previewToken === token && get().sourcePath === sourcePath) {
				set({
					previewUrl: url,
					lastBackendOps: backendOps,
					previewing: false,
				});
			} else {
				set({ previewing: false });
			}
		} catch (e) {
			console.error("preview_edit failed:", e);
			set({ previewing: false });
		}
		// Re-fire if more edits piled up while we were running.
		if (get().previewStale) {
			void get().refreshPreview();
		}
	},
}));

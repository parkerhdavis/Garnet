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
	| { type: "luminance_curve"; lut: number[] }
	| { type: "crop"; x: number; y: number; w: number; h: number }
	| { type: "resize"; w: number; h: number }
	| { type: "rotate"; angle: number }
	| { type: "corner_round"; radius: number };

/// Ops that map cleanly onto CSS `filter:` primitives — these can be
/// previewed client-side, in real time, at full resolution, with no
/// backend round-trip. `luminance_curve` is intentionally excluded
/// (no CSS equivalent, would need a WebGL pass).
export function isCssFilterOp(op: Operation): boolean {
	return (
		op.type === "adjust_hue" ||
		op.type === "adjust_saturation" ||
		op.type === "adjust_brightness" ||
		op.type === "adjust_contrast"
	);
}

/// Split the pipeline at the last op that *can't* be represented as a
/// CSS filter. Backend renders everything up to and including that op;
/// the trailing CSS-representable adjusts overlay onto the result as a
/// real-time `filter:` chain. When `backendOps` is empty, the canvas
/// can render the original directly with the CSS chain on top — that's
/// the hot path for slider-only edits and it never touches Rust.
export function splitOps(ops: Operation[]): {
	backendOps: Operation[];
	cssOps: Operation[];
} {
	let lastNonCss = -1;
	for (let i = ops.length - 1; i >= 0; i--) {
		if (!isCssFilterOp(ops[i])) {
			lastNonCss = i;
			break;
		}
	}
	if (lastNonCss === -1) return { backendOps: [], cssOps: ops };
	return {
		backendOps: ops.slice(0, lastNonCss + 1),
		cssOps: ops.slice(lastNonCss + 1),
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
	/// True when the canvas should render the original pixels — used by
	/// the `\` peek/toggle keybind. The original is loaded as the initial
	/// preview, so the canvas just stops re-rendering edits while this is on.
	viewMode: "edited" | "original";
	/// True after any op has landed; reset on load / save / reset.
	dirty: boolean;

	load: (path: string, name: string) => Promise<void>;
	/// Push or replace an op. If `replaceLastOfType` is true, the last op
	/// with the same `type` is replaced — used by slider drags so each
	/// slider only contributes one entry to the pipeline (and one undo
	/// step) rather than one per frame.
	pushOp: (op: Operation, opts?: { replaceLastOfType?: boolean }) => Promise<void>;
	/// Pop the trailing op (used by undo).
	popOp: () => Promise<void>;
	/// Replace the entire op list (used by redo restoring a full state).
	setOps: (ops: Operation[]) => Promise<void>;
	setViewMode: (mode: "edited" | "original") => void;
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
	viewMode: "edited",
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
			dirty: false,
		});
		await get().refreshPreview();
	},

	pushOp: async (op, opts) => {
		const replace = opts?.replaceLastOfType === true;
		const current = get().pendingOps;
		let next: Operation[];
		if (replace && current.length > 0 && current[current.length - 1].type === op.type) {
			next = [...current.slice(0, -1), op];
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
			dirty: false,
		}),

	refreshPreview: async () => {
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
			set({
				previewUrl: url,
				lastBackendOps: backendOps,
				previewing: false,
			});
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

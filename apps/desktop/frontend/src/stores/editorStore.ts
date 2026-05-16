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

const PREVIEW_MAX_PX = 1600;

interface EditorState {
	/// Absolute path of the source image. null when no asset is loaded.
	sourcePath: string | null;
	/// Friendly name shown in the header / save dialog default.
	sourceName: string | null;
	/// Ordered list of pending operations — replayed from the original on
	/// every preview/commit. Cleared on `reset` or after a successful save.
	pendingOps: Operation[];
	/// Latest preview as a base64-encoded PNG (no data: prefix).
	previewBase64: string | null;
	/// True while a preview round-trip is in flight.
	previewing: boolean;
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
	previewBase64: null,
	previewing: false,
	viewMode: "edited",
	dirty: false,

	load: async (path, name) => {
		set({
			sourcePath: path,
			sourceName: name,
			pendingOps: [],
			previewBase64: null,
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
			previewBase64: null,
			previewing: false,
			viewMode: "edited",
			dirty: false,
		}),

	refreshPreview: async () => {
		const { sourcePath, pendingOps } = get();
		if (!sourcePath) return;
		// Empty pipeline = "edited" view is the original. The canvas
		// renders the source directly via the asset protocol in that
		// case (see EditorPage); no need to round-trip a full decode +
		// PNG re-encode + base64 transfer just to reproduce the input.
		if (pendingOps.length === 0) {
			set({ previewBase64: null, previewing: false });
			return;
		}
		set({ previewing: true });
		try {
			const b64 = await invoke<string>("preview_edit", {
				path: sourcePath,
				ops: pendingOps,
				maxPreviewSize: PREVIEW_MAX_PX,
			});
			set({ previewBase64: b64, previewing: false });
		} catch (e) {
			console.error("preview_edit failed:", e);
			set({ previewing: false });
		}
	},
}));

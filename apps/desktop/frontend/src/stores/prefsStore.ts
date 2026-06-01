// SPDX-License-Identifier: AGPL-3.0-or-later
//! User preferences persisted to localStorage. Distinct from `AppSettings`
//! (backend JSON, currently window-only) — preferences here are pure UX state
//! the frontend owns end-to-end. If a preference later needs to influence
//! Rust-side behavior, migrate it into the backend settings struct.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_ACCENT_ID } from "@/lib/accent";
import type { AnimatedImagesBucket } from "@/lib/typeFilters";

/** Default save behavior for the image editor.
 *  - `new_file`: prompt for a target path on every save (default same folder,
 *    suggested name `{stem}-edited.{ext}`). Non-destructive — matches Packi's
 *    batch-processor stance.
 *  - `overwrite`: write back to the original path without prompting. */
export type EditorSaveDefault = "new_file" | "overwrite";

/** Application zoom (webview scale factor). 1 = 100%; clamped to a sane range
 *  and snapped to one-decimal steps so repeated +/- doesn't drift. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
function clampZoom(z: number): number {
	return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
}

type PrefsState = {
	/** Where GIF / APNG / animated WebP show up in the sidebar Types section.
	 *  Default "images" matches the MIME-level intuition; the toggle is exposed
	 *  in Settings → General for users who think of GIFs as animations. */
	animatedImagesBucket: AnimatedImagesBucket;
	setAnimatedImagesBucket: (bucket: AnimatedImagesBucket) => void;
	editorSaveDefault: EditorSaveDefault;
	setEditorSaveDefault: (mode: EditorSaveDefault) => void;
	/** Application zoom factor, applied to the webview and persisted. */
	zoom: number;
	zoomIn: () => void;
	zoomOut: () => void;
	resetZoom: () => void;
	/** Chosen accent-color preset id (see lib/accent.ts). */
	accentId: string;
	setAccentId: (id: string) => void;
};

export const usePrefsStore = create<PrefsState>()(
	persist(
		(set) => ({
			animatedImagesBucket: "images",
			setAnimatedImagesBucket: (bucket) =>
				set({ animatedImagesBucket: bucket }),
			editorSaveDefault: "new_file",
			setEditorSaveDefault: (mode) => set({ editorSaveDefault: mode }),
			zoom: 1,
			zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom + ZOOM_STEP) })),
			zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom - ZOOM_STEP) })),
			resetZoom: () => set({ zoom: 1 }),
			accentId: DEFAULT_ACCENT_ID,
			setAccentId: (accentId) => set({ accentId }),
		}),
		{ name: "garnet-prefs" },
	),
);

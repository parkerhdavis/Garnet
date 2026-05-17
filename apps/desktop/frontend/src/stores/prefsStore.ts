// SPDX-License-Identifier: AGPL-3.0-or-later
//! User preferences persisted to localStorage. Distinct from `AppSettings`
//! (backend JSON, currently window-only) — preferences here are pure UX state
//! the frontend owns end-to-end. If a preference later needs to influence
//! Rust-side behavior, migrate it into the backend settings struct.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AnimatedImagesBucket } from "@/lib/typeFilters";

/** Default save behavior for the image editor.
 *  - `new_file`: prompt for a target path on every save (default same folder,
 *    suggested name `{stem}-edited.{ext}`). Non-destructive — matches Packi's
 *    batch-processor stance.
 *  - `overwrite`: write back to the original path without prompting. */
export type EditorSaveDefault = "new_file" | "overwrite";

type PrefsState = {
	/** Where GIF / APNG / animated WebP show up in the sidebar Types section.
	 *  Default "images" matches the MIME-level intuition; the toggle is exposed
	 *  in Settings → General for users who think of GIFs as animations. */
	animatedImagesBucket: AnimatedImagesBucket;
	setAnimatedImagesBucket: (bucket: AnimatedImagesBucket) => void;
	editorSaveDefault: EditorSaveDefault;
	setEditorSaveDefault: (mode: EditorSaveDefault) => void;
};

export const usePrefsStore = create<PrefsState>()(
	persist(
		(set) => ({
			animatedImagesBucket: "images",
			setAnimatedImagesBucket: (bucket) => set({ animatedImagesBucket: bucket }),
			editorSaveDefault: "new_file",
			setEditorSaveDefault: (mode) => set({ editorSaveDefault: mode }),
		}),
		{ name: "garnet-prefs" },
	),
);

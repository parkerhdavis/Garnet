// SPDX-License-Identifier: AGPL-3.0-or-later
//! User preferences persisted to localStorage. Distinct from `AppSettings`
//! (backend JSON, currently window-only) — preferences here are pure UX state
//! the frontend owns end-to-end. If a preference later needs to influence
//! Rust-side behavior, migrate it into the backend settings struct.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AnimatedImagesBucket } from "@/lib/typeFilters";

type PrefsState = {
	/** Where GIF / APNG / animated WebP show up in the sidebar Types section.
	 *  Default "images" matches the MIME-level intuition; the toggle is exposed
	 *  in Settings → General for users who think of GIFs as animations. */
	animatedImagesBucket: AnimatedImagesBucket;
	setAnimatedImagesBucket: (bucket: AnimatedImagesBucket) => void;
};

export const usePrefsStore = create<PrefsState>()(
	persist(
		(set) => ({
			animatedImagesBucket: "images",
			setAnimatedImagesBucket: (bucket) => set({ animatedImagesBucket: bucket }),
		}),
		{ name: "garnet-prefs" },
	),
);

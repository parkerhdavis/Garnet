// SPDX-License-Identifier: AGPL-3.0-or-later
//! Recently opened ad-hoc files. Every ad-hoc entry point (the Open-file
//! picker, a window drop, an OS "Open with Garnet") records the path here so it
//! can be reopened from the sidebar or the command palette without re-picking.
//! Pure frontend UX state, persisted to localStorage like `prefsStore`.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RecentFile = { path: string; name: string; openedAt: number };

const MAX_RECENTS = 12;

type State = {
	recents: RecentFile[];
	/// Record an open. Moves an already-present path to the front (most-recent)
	/// rather than duplicating it, and caps the list.
	record: (path: string, name: string) => void;
	remove: (path: string) => void;
	clear: () => void;
};

export const useRecentFilesStore = create<State>()(
	persist(
		(set) => ({
			recents: [],
			record: (path, name) =>
				set((s) => {
					const without = s.recents.filter((r) => r.path !== path);
					const entry: RecentFile = { path, name, openedAt: Date.now() };
					return { recents: [entry, ...without].slice(0, MAX_RECENTS) };
				}),
			remove: (path) =>
				set((s) => ({ recents: s.recents.filter((r) => r.path !== path) })),
			clear: () => set({ recents: [] }),
		}),
		{ name: "garnet-recent-files" },
	),
);

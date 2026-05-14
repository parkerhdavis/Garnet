// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pinned-source list backing the sidebar's Sources section. Pins are
//! validated server-side (they must resolve inside an existing library root),
//! so the store just reflects whatever the Rust side reports.

import { create } from "zustand";
import { api, type PinnedSource } from "@/lib/tauri";

type State = {
	sources: PinnedSource[];
	loading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	pin: (absPath: string, name?: string | null) => Promise<PinnedSource | null>;
	unpin: (id: number) => Promise<void>;
};

export const usePinnedSourcesStore = create<State>((set, get) => ({
	sources: [],
	loading: true,
	error: null,

	refresh: async () => {
		set({ loading: true, error: null });
		try {
			const sources = await api.listPinnedSources();
			set({ sources, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},

	pin: async (absPath, name) => {
		set({ error: null });
		try {
			const pin = await api.pinSource(absPath, name);
			await get().refresh();
			return pin;
		} catch (e) {
			set({ error: String(e) });
			return null;
		}
	},

	unpin: async (id) => {
		set({ error: null });
		try {
			await api.unpinSource(id);
			await get().refresh();
		} catch (e) {
			set({ error: String(e) });
		}
	},
}));

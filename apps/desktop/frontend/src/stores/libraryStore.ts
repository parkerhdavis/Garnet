// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { api, type LibraryRoot, type ScanReport } from "@/lib/tauri";

type LibraryState = {
	roots: LibraryRoot[];
	lastScan: ScanReport | null;
	loading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	addRoot: (path: string) => Promise<void>;
	removeRoot: (id: number) => Promise<void>;
	scanRoot: (id: number) => Promise<void>;
};

export const useLibraryStore = create<LibraryState>((set, get) => ({
	roots: [],
	lastScan: null,
	// Start as `true` — the empty roots list combined with `loading: false`
	// otherwise reads as "0 roots" on the very first render, before any
	// `refresh()` has had a chance to run, and the LibraryPage briefly shows
	// the "No library roots yet" empty state even when roots are configured.
	loading: true,
	error: null,

	refresh: async () => {
		set({ loading: true, error: null });
		try {
			const roots = await api.listLibraryRoots();
			set({ roots, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},

	addRoot: async (path: string) => {
		set({ error: null });
		try {
			await api.registerLibraryRoot(path);
			await get().refresh();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	removeRoot: async (id: number) => {
		set({ error: null });
		try {
			await api.removeLibraryRoot(id);
			await get().refresh();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	scanRoot: async (id: number) => {
		set({ error: null, lastScan: null });
		try {
			const report = await api.scanLibraryRoot(id);
			set({ lastScan: report });
		} catch (e) {
			set({ error: String(e) });
		}
	},
}));

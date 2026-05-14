// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { api, type LibraryRoot, type ScanReport } from "@/lib/tauri";

type ScanStatus = "idle" | "running";

type LibraryState = {
	roots: LibraryRoot[];
	lastScan: ScanReport | null;
	loading: boolean;
	error: string | null;
	/** Set of root ids currently being scanned (background task in flight). */
	scansInProgress: Set<number>;
	refresh: () => Promise<void>;
	addRoot: (path: string) => Promise<void>;
	removeRoot: (id: number) => Promise<void>;
	/** Kicks off a background scan; resolves as soon as the IPC call is
	 * accepted. Completion arrives via the `scan:completed` event handled in
	 * `App.tsx`. */
	scanRoot: (id: number) => Promise<void>;
	scanStatus: (id: number) => ScanStatus;
	_markScanStarted: (id: number) => void;
	_markScanFinished: (id: number, report: ScanReport | null) => void;
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
	scansInProgress: new Set(),

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
		set({ error: null });
		try {
			await api.scanLibraryRoot(id);
			// scan_library_root now returns immediately; the actual scan runs
			// on a background tokio task. Lifecycle events (scan:started /
			// :completed / :failed) update the store via the listeners in
			// App.tsx, so there's no .then() / .await wait here.
		} catch (e) {
			set({ error: String(e) });
		}
	},

	scanStatus: (id) => (get().scansInProgress.has(id) ? "running" : "idle"),

	_markScanStarted: (id) => {
		set((s) => {
			const next = new Set(s.scansInProgress);
			next.add(id);
			return { scansInProgress: next };
		});
	},

	_markScanFinished: (id, report) => {
		set((s) => {
			const next = new Set(s.scansInProgress);
			next.delete(id);
			return {
				scansInProgress: next,
				lastScan: report ?? s.lastScan,
			};
		});
	},
}));

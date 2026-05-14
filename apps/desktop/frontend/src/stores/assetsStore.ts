// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library-view query state: filters, sort, view mode, and the current page of
//! assets. Cross-root by default; `rootId` scopes to one root.

import { create } from "zustand";
import {
	api,
	type Asset,
	type AssetSortBy,
	type FormatCount,
	type SortDir,
	type TagWithCount,
} from "@/lib/tauri";

export const PAGE_SIZE = 60;

export type ViewMode = "grid" | "list";

// Token for cancelling stale refresh() responses. Each refresh increments the
// counter and remembers its own value; if the value at response time no
// longer matches, the response is discarded. Without this, a slow earlier
// refresh can land *after* a later one and overwrite the filtered results
// with stale unfiltered ones — the bug we hit when SourcePage and
// LibraryPage both kicked off refresh on mount.
let refreshToken = 0;

type AssetsState = {
	// Query parameters
	rootId: number | null;
	formats: string[];
	tagIds: number[];
	pinnedSourceId: number | null;
	pathSearch: string;
	sizeMin: number | null;
	sizeMax: number | null;
	mtimeFrom: number | null;
	mtimeTo: number | null;
	sortBy: AssetSortBy;
	sortDir: SortDir;
	page: number;

	// View
	viewMode: ViewMode;

	// Data
	assets: Asset[];
	total: number;
	formatCounts: FormatCount[];
	tagCounts: TagWithCount[];
	loading: boolean;
	error: string | null;

	// Actions
	setRootId: (rootId: number | null) => Promise<void>;
	setPinnedSourceId: (id: number | null) => Promise<void>;
	toggleFormat: (format: string) => Promise<void>;
	clearFormats: () => Promise<void>;
	toggleTagFilter: (tagId: number) => Promise<void>;
	clearTagFilter: () => Promise<void>;
	setPathSearch: (search: string) => Promise<void>;
	setSizeMin: (min: number | null) => Promise<void>;
	setSizeMax: (max: number | null) => Promise<void>;
	setMtimeFrom: (from: number | null) => Promise<void>;
	setMtimeTo: (to: number | null) => Promise<void>;
	setSort: (by: AssetSortBy) => Promise<void>;
	setPage: (page: number) => Promise<void>;
	setViewMode: (mode: ViewMode) => void;
	resetFilters: () => Promise<void>;
	refresh: () => Promise<void>;
};

export const useAssetsStore = create<AssetsState>((set, get) => ({
	rootId: null,
	formats: [],
	tagIds: [],
	pinnedSourceId: null,
	pathSearch: "",
	sizeMin: null,
	sizeMax: null,
	mtimeFrom: null,
	mtimeTo: null,
	sortBy: "path",
	sortDir: "asc",
	page: 0,

	viewMode: "grid",

	assets: [],
	total: 0,
	formatCounts: [],
	tagCounts: [],
	// Same rationale as libraryStore: start as loading so the first paint
	// doesn't show "No assets match the current filters" before the initial
	// query has had a chance to fire.
	loading: true,
	error: null,

	setRootId: async (rootId) => {
		set({ rootId, page: 0 });
		await get().refresh();
	},

	setPinnedSourceId: async (id) => {
		set({ pinnedSourceId: id, page: 0 });
		await get().refresh();
	},

	toggleFormat: async (format) => {
		const lc = format.toLowerCase();
		const current = get().formats;
		const next = current.includes(lc) ? current.filter((f) => f !== lc) : [...current, lc];
		set({ formats: next, page: 0 });
		await get().refresh();
	},

	clearFormats: async () => {
		set({ formats: [], page: 0 });
		await get().refresh();
	},

	toggleTagFilter: async (tagId) => {
		const current = get().tagIds;
		const next = current.includes(tagId)
			? current.filter((t) => t !== tagId)
			: [...current, tagId];
		set({ tagIds: next, page: 0 });
		await get().refresh();
	},

	clearTagFilter: async () => {
		set({ tagIds: [], page: 0 });
		await get().refresh();
	},

	setPathSearch: async (search) => {
		set({ pathSearch: search, page: 0 });
		await get().refresh();
	},

	setSizeMin: async (min) => {
		set({ sizeMin: min, page: 0 });
		await get().refresh();
	},
	setSizeMax: async (max) => {
		set({ sizeMax: max, page: 0 });
		await get().refresh();
	},
	setMtimeFrom: async (from) => {
		set({ mtimeFrom: from, page: 0 });
		await get().refresh();
	},
	setMtimeTo: async (to) => {
		set({ mtimeTo: to, page: 0 });
		await get().refresh();
	},

	setSort: async (by) => {
		const { sortBy, sortDir } = get();
		const nextDir: SortDir = sortBy === by ? (sortDir === "asc" ? "desc" : "asc") : "asc";
		set({ sortBy: by, sortDir: nextDir, page: 0 });
		await get().refresh();
	},

	setPage: async (page) => {
		set({ page: Math.max(0, page) });
		await get().refresh();
	},

	setViewMode: (viewMode) => {
		set({ viewMode });
	},

	resetFilters: async () => {
		set({
			formats: [],
			tagIds: [],
			pathSearch: "",
			sizeMin: null,
			sizeMax: null,
			mtimeFrom: null,
			mtimeTo: null,
			page: 0,
		});
		await get().refresh();
	},

	refresh: async () => {
		const myToken = ++refreshToken;
		const s = get();
		// Note: don't clear `error` here. It's used for sticky user-facing
		// messages from asset operations (rename/move/trash failures, "moved
		// out of library" notices). A background scan-driven refresh
		// shouldn't wipe a message the user hasn't read yet. The error
		// banner has its own dismiss button.
		set({ loading: true });
		try {
			const [page, formatCounts, tagCounts] = await Promise.all([
				api.listAssets({
					root_id: s.rootId,
					limit: PAGE_SIZE,
					offset: s.page * PAGE_SIZE,
					sort_by: s.sortBy,
					sort_dir: s.sortDir,
					formats: s.formats,
					path_search: s.pathSearch.trim() || null,
					size_min: s.sizeMin,
					size_max: s.sizeMax,
					mtime_from: s.mtimeFrom,
					mtime_to: s.mtimeTo,
					tag_ids: s.tagIds,
					pinned_source_id: s.pinnedSourceId,
				}),
				api.listAssetFormats(s.rootId),
				api.listTags(),
			]);
			if (myToken !== refreshToken) return; // superseded by a later refresh
			set({
				assets: page.assets,
				total: page.total,
				formatCounts,
				tagCounts,
				loading: false,
			});
		} catch (e) {
			if (myToken !== refreshToken) return;
			console.error("[assetsStore.refresh] failed", e);
			set({ error: String(e), loading: false });
		}
	},
}));

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

type AssetsState = {
	// Query parameters
	rootId: number | null;
	formats: string[];
	tagIds: number[];
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
	loading: false,
	error: null,

	setRootId: async (rootId) => {
		set({ rootId, page: 0 });
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
		const s = get();
		set({ loading: true, error: null });
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
				}),
				api.listAssetFormats(s.rootId),
				api.listTags(),
			]);
			set({
				assets: page.assets,
				total: page.total,
				formatCounts,
				tagCounts,
				loading: false,
			});
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},
}));

// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import {
	api,
	type Asset,
	type AssetSortBy,
	type FormatCount,
	type SortDir,
} from "@/lib/tauri";

export const PAGE_SIZE = 100;

type AssetsState = {
	rootId: number | null;
	assets: Asset[];
	total: number;
	formats: FormatCount[];
	page: number;
	sortBy: AssetSortBy;
	sortDir: SortDir;
	formatFilter: string | null;
	loading: boolean;
	error: string | null;

	openRoot: (rootId: number) => Promise<void>;
	close: () => void;
	setPage: (page: number) => Promise<void>;
	setSort: (by: AssetSortBy) => Promise<void>;
	setFormatFilter: (format: string | null) => Promise<void>;
	refresh: () => Promise<void>;
};

export const useAssetsStore = create<AssetsState>((set, get) => ({
	rootId: null,
	assets: [],
	total: 0,
	formats: [],
	page: 0,
	sortBy: "path",
	sortDir: "asc",
	formatFilter: null,
	loading: false,
	error: null,

	openRoot: async (rootId: number) => {
		set({
			rootId,
			page: 0,
			sortBy: "path",
			sortDir: "asc",
			formatFilter: null,
			assets: [],
			total: 0,
			formats: [],
			error: null,
		});
		await get().refresh();
	},

	close: () => {
		set({ rootId: null, assets: [], total: 0, formats: [], error: null });
	},

	setPage: async (page: number) => {
		set({ page: Math.max(0, page) });
		await get().refresh();
	},

	setSort: async (by: AssetSortBy) => {
		const { sortBy, sortDir } = get();
		const nextDir: SortDir = sortBy === by ? (sortDir === "asc" ? "desc" : "asc") : "asc";
		set({ sortBy: by, sortDir: nextDir, page: 0 });
		await get().refresh();
	},

	setFormatFilter: async (format: string | null) => {
		set({ formatFilter: format, page: 0 });
		await get().refresh();
	},

	refresh: async () => {
		const { rootId, page, sortBy, sortDir, formatFilter } = get();
		if (rootId === null) return;
		set({ loading: true, error: null });
		try {
			const [page$, formats] = await Promise.all([
				api.listAssets({
					root_id: rootId,
					limit: PAGE_SIZE,
					offset: page * PAGE_SIZE,
					sort_by: sortBy,
					sort_dir: sortDir,
					format_filter: formatFilter ?? null,
				}),
				api.listAssetFormats(rootId),
			]);
			set({
				assets: page$.assets,
				total: page$.total,
				formats,
				loading: false,
			});
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},
}));

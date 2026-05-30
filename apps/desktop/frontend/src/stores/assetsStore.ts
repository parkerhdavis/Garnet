// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library-view query state: filters, sort, view mode, and the loaded assets.
//! Cross-root by default; `rootId` scopes to one root. Results stream in via
//! infinite scroll: `reset` loads the first page (used whenever the query
//! changes), `loadMore` appends the next page as the user scrolls, and
//! `refresh` reloads the currently-loaded window in place (used after edits and
//! background scans, so scroll position is preserved).

import { create } from "zustand";
import {
	api,
	type Asset,
	type AssetGroupBy,
	type AssetQuery,
	type AssetSortBy,
	type FormatCount,
	type SortDir,
	type ValueCount,
} from "@/lib/tauri";
import { buildTypeQuery, formatsInKind, type TypeKind } from "@/lib/typeFilters";
import { usePrefsStore } from "@/stores/prefsStore";

export const PAGE_SIZE = 60;

export type ViewMode = "grid" | "list";

/** The subset of library filter/sort state a Library workspace persists. Omits
 *  root/pinned-source/viewMode — those are navigation context, not a saved
 *  query. */
export type SavedLibraryQuery = {
	formats: string[];
	tagNames: string[];
	pathSearch: string;
	/// Absolute folder the view is scoped to (null = whole library). Set by a
	/// Library workspace from its `rootFolder` config; not part of the FilterBar.
	underPath: string | null;
	sizeMin: number | null;
	sizeMax: number | null;
	mtimeFrom: number | null;
	mtimeTo: number | null;
	sortBy: AssetSortBy;
	sortDir: SortDir;
	groupBy: AssetGroupBy;
	groupDir: SortDir;
	typeKind: TypeKind | null;
};

/** A cleared query — applied when a Library workspace has no saved filter so
 *  entering it starts from a clean slate rather than leaking the previous
 *  view's filters. */
export const EMPTY_LIBRARY_QUERY: SavedLibraryQuery = {
	formats: [],
	tagNames: [],
	pathSearch: "",
	underPath: null,
	sizeMin: null,
	sizeMax: null,
	mtimeFrom: null,
	mtimeTo: null,
	sortBy: "path",
	sortDir: "asc",
	groupBy: "none",
	groupDir: "asc",
	typeKind: null,
};

// Token for cancelling stale responses. Each reset/refresh increments the
// counter and remembers its own value; if the value at response time no
// longer matches, the response is discarded. Without this, a slow earlier
// query can land *after* a later one and overwrite the filtered results
// with stale unfiltered ones — the bug we hit when SourcePage and
// LibraryPage both kicked off a query on mount. A loadMore append ties itself
// to the current token so a reset mid-flight discards the late append.
let refreshToken = 0;

type AssetsState = {
	// Query parameters
	rootId: number | null;
	formats: string[];
	tagNames: string[];
	pinnedSourceId: number | null;
	/** Active Types-sidebar filter (Images/Videos/Audio/Models/Animations/Other).
	 *  Null when not on a /types/:kind route. */
	typeKind: TypeKind | null;
	pathSearch: string;
	/// Folder scope (null = whole library). Driven by a Library workspace's
	/// rootFolder; cleared when leaving the workspace.
	underPath: string | null;
	sizeMin: number | null;
	sizeMax: number | null;
	mtimeFrom: number | null;
	mtimeTo: number | null;
	sortBy: AssetSortBy;
	sortDir: SortDir;
	groupBy: AssetGroupBy;
	groupDir: SortDir;

	// View
	viewMode: ViewMode;

	// Data
	assets: Asset[];
	total: number;
	formatCounts: FormatCount[];
	tagCounts: ValueCount[];
	loading: boolean;
	/// True while a loadMore append is in flight (distinct from `loading`, the
	/// initial/whole-window load) so the grid stays visible while appending.
	loadingMore: boolean;
	/// Bumped each time the query is reset to its first page, so the browse pane
	/// can scroll back to the top on a filter/sort change.
	resetNonce: number;
	error: string | null;

	// Actions
	setRootId: (rootId: number | null) => Promise<void>;
	setPinnedSourceId: (id: number | null) => Promise<void>;
	setTypeKind: (kind: TypeKind | null) => Promise<void>;
	toggleFormat: (format: string) => Promise<void>;
	clearFormats: () => Promise<void>;
	toggleTagFilter: (tagName: string) => Promise<void>;
	clearTagFilter: () => Promise<void>;
	setPathSearch: (search: string) => Promise<void>;
	setSizeMin: (min: number | null) => Promise<void>;
	setSizeMax: (max: number | null) => Promise<void>;
	setMtimeFrom: (from: number | null) => Promise<void>;
	setMtimeTo: (to: number | null) => Promise<void>;
	setSort: (by: AssetSortBy) => Promise<void>;
	setGroupBy: (groupBy: AssetGroupBy) => Promise<void>;
	setGroupDir: (dir: SortDir) => Promise<void>;
	setViewMode: (mode: ViewMode) => void;
	resetFilters: () => Promise<void>;
	/** Snapshot the persistable filter/sort state (for saving to a workspace). */
	snapshotFilters: () => SavedLibraryQuery;
	/** Apply a saved query wholesale (clearing anything it doesn't specify) and
	 *  load its first page. Used when entering / leaving a Library workspace. */
	applyFilters: (q: SavedLibraryQuery) => Promise<void>;
	/** Load the next page and append it. No-op while loading or fully loaded. */
	loadMore: () => Promise<void>;
	/** Collapse to the first page and reload (scrolling back to top). Used
	 *  whenever the query changes. */
	reset: () => Promise<void>;
	/** Reload the currently-loaded window in place, preserving how far the user
	 *  has scrolled. Used after asset edits and background scans. */
	refresh: () => Promise<void>;
};

/// Build the listAssets query for the current filter/sort state.
function listQuery(s: AssetsState, limit: number, offset: number): AssetQuery {
	const bucket = usePrefsStore.getState().animatedImagesBucket;
	const typeQuery = buildTypeQuery(s.typeKind, bucket, s.formats);
	return {
		root_id: s.rootId,
		limit,
		offset,
		sort_by: s.sortBy,
		sort_dir: s.sortDir,
		group_by: s.groupBy,
		group_dir: s.groupDir,
		formats: typeQuery.formats,
		formats_exclude: typeQuery.formats_exclude,
		exclude_motion_only: typeQuery.exclude_motion_only,
		motion_only_overlay: typeQuery.motion_only_overlay,
		path_search: s.pathSearch.trim() || null,
		under_path: s.underPath,
		size_min: s.sizeMin,
		size_max: s.sizeMax,
		mtime_from: s.mtimeFrom,
		mtime_to: s.mtimeTo,
		tag_names: s.tagNames,
		pinned_source_id: s.pinnedSourceId,
	};
}

export const useAssetsStore = create<AssetsState>((set, get) => {
	/// Shared loader for the from-the-top reload. `collapse` loads a single
	/// page and scrolls to top (a query change); otherwise it reloads however
	/// much is currently loaded, in place (an edit/scan refresh).
	const reload = async (collapse: boolean) => {
		const myToken = ++refreshToken;
		const s = get();
		const bucket = usePrefsStore.getState().animatedImagesBucket;
		const limit = collapse ? PAGE_SIZE : Math.max(PAGE_SIZE, s.assets.length);
		// Note: don't clear `error` here. It's used for sticky user-facing
		// messages from asset operations (rename/move/trash failures, "moved
		// out of library" notices). A background scan-driven refresh
		// shouldn't wipe a message the user hasn't read yet. The error
		// banner has its own dismiss button.
		set(collapse ? { loading: true, resetNonce: s.resetNonce + 1 } : { loading: true });
		try {
			const [page, rawFormatCounts, tagCounts] = await Promise.all([
				api.listAssets(listQuery(s, limit, 0)),
				api.listAssetFormats(s.rootId),
				api.listGarnetMetadataValuesForKey("tags"),
			]);
			if (myToken !== refreshToken) return; // superseded by a later query
			// Scope FilterBar's format chips to the active type: drop counts for
			// formats that don't belong to the type, so users don't see e.g.
			// "jpg" while viewing /types/videos.
			const formatCounts = rawFormatCounts.filter((fc) =>
				formatsInKind(s.typeKind, bucket, fc.format),
			);
			set({
				assets: page.assets,
				total: page.total,
				formatCounts,
				tagCounts,
				loading: false,
				loadingMore: false,
			});
		} catch (e) {
			if (myToken !== refreshToken) return;
			console.error("[assetsStore.reload] failed", e);
			set({ error: String(e), loading: false, loadingMore: false });
		}
	};

	return {
		rootId: null,
		formats: [],
		tagNames: [],
		pinnedSourceId: null,
		typeKind: null,
		pathSearch: "",
		underPath: null,
		sizeMin: null,
		sizeMax: null,
		mtimeFrom: null,
		mtimeTo: null,
		sortBy: "path",
		sortDir: "asc",
		groupBy: "none",
		groupDir: "asc",

		viewMode: "grid",

		assets: [],
		total: 0,
		formatCounts: [],
		tagCounts: [],
		// Same rationale as libraryStore: start as loading so the first paint
		// doesn't show "No assets match the current filters" before the initial
		// query has had a chance to fire.
		loading: true,
		loadingMore: false,
		resetNonce: 0,
		error: null,

		setRootId: async (rootId) => {
			set({ rootId });
			await get().reset();
		},

		setPinnedSourceId: async (id) => {
			set({ pinnedSourceId: id });
			await get().reset();
		},

		setTypeKind: async (kind) => {
			if (get().typeKind === kind) return;
			set({ typeKind: kind });
			await get().reset();
		},

		toggleFormat: async (format) => {
			const lc = format.toLowerCase();
			const current = get().formats;
			const next = current.includes(lc) ? current.filter((f) => f !== lc) : [...current, lc];
			set({ formats: next });
			await get().reset();
		},

		clearFormats: async () => {
			set({ formats: [] });
			await get().reset();
		},

		toggleTagFilter: async (tagName) => {
			const current = get().tagNames;
			const next = current.includes(tagName)
				? current.filter((t) => t !== tagName)
				: [...current, tagName];
			set({ tagNames: next });
			await get().reset();
		},

		clearTagFilter: async () => {
			set({ tagNames: [] });
			await get().reset();
		},

		setPathSearch: async (search) => {
			set({ pathSearch: search });
			await get().reset();
		},

		setSizeMin: async (min) => {
			set({ sizeMin: min });
			await get().reset();
		},
		setSizeMax: async (max) => {
			set({ sizeMax: max });
			await get().reset();
		},
		setMtimeFrom: async (from) => {
			set({ mtimeFrom: from });
			await get().reset();
		},
		setMtimeTo: async (to) => {
			set({ mtimeTo: to });
			await get().reset();
		},

		setSort: async (by) => {
			const { sortBy, sortDir } = get();
			const nextDir: SortDir = sortBy === by ? (sortDir === "asc" ? "desc" : "asc") : "asc";
			set({ sortBy: by, sortDir: nextDir });
			await get().reset();
		},

		setGroupBy: async (groupBy) => {
			if (get().groupBy === groupBy) return;
			set({ groupBy });
			await get().reset();
		},

		setGroupDir: async (groupDir) => {
			if (get().groupDir === groupDir) return;
			set({ groupDir });
			await get().reset();
		},

		setViewMode: (viewMode) => {
			set({ viewMode });
		},

		resetFilters: async () => {
			set({
				formats: [],
				tagNames: [],
				pathSearch: "",
				sizeMin: null,
				sizeMax: null,
				mtimeFrom: null,
				mtimeTo: null,
			});
			await get().reset();
		},

		snapshotFilters: () => {
			const s = get();
			return {
				formats: [...s.formats],
				tagNames: [...s.tagNames],
				pathSearch: s.pathSearch,
				underPath: s.underPath,
				sizeMin: s.sizeMin,
				sizeMax: s.sizeMax,
				mtimeFrom: s.mtimeFrom,
				mtimeTo: s.mtimeTo,
				sortBy: s.sortBy,
				sortDir: s.sortDir,
				groupBy: s.groupBy,
				groupDir: s.groupDir,
				typeKind: s.typeKind,
			};
		},

		applyFilters: async (q) => {
			set({ ...q });
			await get().reset();
		},

		loadMore: async () => {
			const s = get();
			if (s.loading || s.loadingMore) return;
			if (s.assets.length >= s.total) return;
			const myToken = refreshToken; // tie to the current query generation
			const offset = s.assets.length;
			set({ loadingMore: true });
			try {
				const page = await api.listAssets(listQuery(s, PAGE_SIZE, offset));
				if (myToken !== refreshToken) {
					// A reset/refresh replaced the query mid-flight; drop the
					// stale append (its `loadingMore` is owned by that reload).
					return;
				}
				set((cur) => ({
					assets: [...cur.assets, ...page.assets],
					total: page.total,
					loadingMore: false,
				}));
			} catch (e) {
				if (myToken !== refreshToken) return;
				console.error("[assetsStore.loadMore] failed", e);
				set({ loadingMore: false, error: String(e) });
			}
		},

		reset: () => reload(true),
		refresh: () => reload(false),
	};
});

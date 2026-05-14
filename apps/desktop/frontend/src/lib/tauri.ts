// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin wrapper around Tauri's `invoke` so frontend call-sites can stay typed
//! without dragging the runtime import into every component file. Commands map
//! one-to-one to `#[tauri::command]` handlers in `apps/desktop/backend/src/`.

import { invoke } from "@tauri-apps/api/core";

export type LibraryRoot = {
	id: number;
	path: string;
	added_at: number;
};

export type ScanReport = {
	root_id: number;
	files_seen: number;
	files_inserted: number;
	files_skipped: number;
};

export type ModuleManifest = {
	identity: string;
	version: string;
	name: string;
	description: string;
	contributions: {
		formats: unknown[];
		previewers: unknown[];
		operations: unknown[];
		pipelines: unknown[];
		search_facets: unknown[];
		settings: unknown[];
	};
};

export type Asset = {
	id: number;
	root_id: number;
	root_path: string;
	relative_path: string;
	size: number | null;
	mtime: number | null;
	format: string | null;
};

export type Tag = {
	id: number;
	name: string;
	parent_id: number | null;
	created_at: number;
};

export type TagWithCount = {
	id: number;
	name: string;
	count: number;
};

export type AssetMetadata = {
	key: string;
	value: string;
};

export type PinnedSource = {
	id: number;
	root_id: number;
	root_path: string;
	relative_path: string;
	abs_path: string;
	name: string;
	added_at: number;
};

export type AssetSortBy = "path" | "size" | "mtime" | "format" | "root";
export type SortDir = "asc" | "desc";

export type AssetQuery = {
	root_id?: number | null;
	limit?: number;
	offset?: number;
	sort_by?: AssetSortBy;
	sort_dir?: SortDir;
	formats?: string[];
	path_search?: string | null;
	size_min?: number | null;
	size_max?: number | null;
	mtime_from?: number | null;
	mtime_to?: number | null;
	tag_ids?: number[];
	pinned_source_id?: number | null;
};

export type AssetPage = {
	assets: Asset[];
	total: number;
};

export type FormatCount = {
	format: string | null;
	count: number;
};

export const api = {
	registerLibraryRoot: (path: string) =>
		invoke<LibraryRoot>("register_library_root", { path }),
	listLibraryRoots: () => invoke<LibraryRoot[]>("list_library_roots"),
	removeLibraryRoot: (id: number) => invoke<void>("remove_library_root", { id }),
	scanLibraryRoot: (id: number) => invoke<ScanReport>("scan_library_root", { id }),
	listAssets: (query: AssetQuery) => invoke<AssetPage>("list_assets", { query }),
	getAsset: (id: number) => invoke<Asset>("get_asset", { id }),
	listAssetFormats: (rootId: number | null) =>
		invoke<FormatCount[]>("list_asset_formats", { rootId }),
	listAssetMetadata: (assetId: number) =>
		invoke<AssetMetadata[]>("list_asset_metadata", { assetId }),
	getThumbnail: (absPath: string, mtime: number | null, size?: number) =>
		invoke<string | null>("get_thumbnail", { absPath, mtime, size }),
	listTags: () => invoke<TagWithCount[]>("list_tags"),
	createTag: (name: string) => invoke<Tag>("create_tag", { name }),
	deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
	tagAsset: (assetId: number, tagId: number) =>
		invoke<void>("tag_asset", { assetId, tagId }),
	untagAsset: (assetId: number, tagId: number) =>
		invoke<void>("untag_asset", { assetId, tagId }),
	listAssetTags: (assetId: number) => invoke<Tag[]>("list_asset_tags", { assetId }),
	listPinnedSources: () => invoke<PinnedSource[]>("list_pinned_sources"),
	pinSource: (absPath: string, name?: string | null) =>
		invoke<PinnedSource>("pin_source", { absPath, name: name ?? null }),
	unpinSource: (id: number) => invoke<void>("unpin_source", { id }),
	listModules: () => invoke<ModuleManifest[]>("list_modules"),
	getMediaPort: () => invoke<number>("get_media_port"),
};

/// Construct a URL for inline `<video>` / `<audio>` playback. Goes through
/// the localhost HTTP server (see backend/src/media_server.rs) rather than
/// the `asset://` protocol — on Linux, webkit2gtk's media element refuses
/// custom URI schemes regardless of how their handlers respond, and Tauri's
/// asset pipe wasn't built to stream video-sized payloads anyway. Images
/// continue to use `convertFileSrc` (asset://) where that works fine.
let _cachedMediaPort: number | null = null;
export async function mediaUrl(absPath: string): Promise<string> {
	if (_cachedMediaPort === null) {
		_cachedMediaPort = await api.getMediaPort();
	}
	return `http://127.0.0.1:${_cachedMediaPort}/file?path=${encodeURIComponent(absPath)}`;
}

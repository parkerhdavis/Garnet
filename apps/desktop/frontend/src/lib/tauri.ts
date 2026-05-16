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
	files_updated: number;
	files_renamed: number;
	files_deleted: number;
	files_skipped: number;
	metadata_extracted: number;
};

export type PluginManifest = {
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
	/// True for 3D files that have a skeleton + animation curves but no
	/// mesh (Mixamo retargeting clips). Set by the frontend thumbnailer
	/// via save_model_thumbnail. null = not yet classified.
	is_motion_only: boolean | null;
};

export type AssetMetadata = {
	key: string;
	value: string;
};

/** A single user-editable metadata entry: one key plus an ordered list of
 *  values. Tags are not a separate type — they're just an entry whose key is
 *  the string `"tags"`. */
export type GarnetMetadataEntry = {
	key: string;
	values: string[];
};

/** Distinct value across the library with the number of assets carrying it.
 *  Used for filter chips (e.g., the tag chip row in FilterBar). */
export type ValueCount = {
	value: string;
	count: number;
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
	formats_exclude?: string[];
	path_search?: string | null;
	size_min?: number | null;
	size_max?: number | null;
	mtime_from?: number | null;
	mtime_to?: number | null;
	tag_names?: string[];
	pinned_source_id?: number | null;
	/// Drop motion-only assets from the result (used by the Models type
	/// view so they end up in Animations instead).
	exclude_motion_only?: boolean;
	/// Additionally include assets whose format is in this list AND
	/// is_motion_only = 1 (used by the Animations type view to bring in
	/// motion-only model files alongside the vanilla animation formats).
	motion_only_overlay?: string[];
};

export type AssetPage = {
	assets: Asset[];
	total: number;
};

export type FormatCount = {
	format: string | null;
	count: number;
};

export type AssetOpResult = {
	asset_id: number;
	relative_path: string;
	abs_path: string;
	previous_abs_path: string;
	/** False if the move dropped the asset from the library (destination
	 *  was outside every registered root). True for in-library moves and
	 *  every rename. */
	still_in_library: boolean;
};

export type StartupPhase = {
	name: string;
	start_offset_ms: number;
	duration_ms: number;
	note: string | null;
};

export type StartupReport = {
	recorded_at_unix_ms: number;
	total_ms: number;
	splash_budget_ms: number | null;
	phases: StartupPhase[];
};

export type TrashResult = {
	trash_path: string;
	original_abs_path: string;
};

export const api = {
	registerLibraryRoot: (path: string) =>
		invoke<LibraryRoot>("register_library_root", { path }),
	listLibraryRoots: () => invoke<LibraryRoot[]>("list_library_roots"),
	removeLibraryRoot: (id: number) => invoke<void>("remove_library_root", { id }),
	scanLibraryRoot: (id: number) => invoke<void>("scan_library_root", { id }),
	listAssets: (query: AssetQuery) => invoke<AssetPage>("list_assets", { query }),
	getAsset: (id: number) => invoke<Asset>("get_asset", { id }),
	listAssetFormats: (rootId: number | null) =>
		invoke<FormatCount[]>("list_asset_formats", { rootId }),
	listAssetMetadata: (assetId: number) =>
		invoke<AssetMetadata[]>("list_asset_metadata", { assetId }),
	/// Pure cache lookup — returns the absolute path of a cached thumbnail
	/// PNG, or null if none exists yet. Never generates; call ensureThumbnail
	/// for that.
	getThumbnail: (absPath: string, mtime: number | null, size?: number) =>
		invoke<string | null>("get_thumbnail", { absPath, mtime, size }),
	/// Fire-and-forget generation request. Resolves as soon as the IPC is
	/// accepted; the actual work happens on the backend's blocking pool and
	/// emits a `thumbnail:ready` event when done.
	ensureThumbnail: (absPath: string, mtime: number | null, size?: number) =>
		invoke<void>("ensure_thumbnail", { absPath, mtime, size }),
	/// Persist a model thumbnail rendered in the frontend (Three.js). The
	/// backend writes it to the same cache path get_thumbnail looks up and
	/// emits `thumbnail:ready`, so the rest of the pipeline is identical to
	/// the image/video flow.
	saveModelThumbnail: (
		assetId: number,
		absPath: string,
		mtime: number | null,
		size: number,
		pngBase64: string,
		motionOnly: boolean,
	) =>
		invoke<void>("save_model_thumbnail", {
			assetId,
			absPath,
			mtime,
			size,
			pngBase64,
			motionOnly,
		}),
	getStartupTimings: () =>
		invoke<StartupReport | null>("get_startup_timings"),
	markStartupPhase: (name: string, note: string | null = null) =>
		invoke<void>("mark_startup_phase", { name, note }),
	finalizeStartupTimings: (splashBudgetMs: number | null = null) =>
		invoke<void>("finalize_startup_timings", { splashBudgetMs }),
	listGarnetMetadata: (assetId: number) =>
		invoke<GarnetMetadataEntry[]>("list_garnet_metadata", { assetId }),
	setGarnetMetadataKey: (assetId: number, key: string, values: string[]) =>
		invoke<void>("set_garnet_metadata_key", { assetId, key, values }),
	addGarnetMetadataValue: (assetId: number, key: string, value: string) =>
		invoke<void>("add_garnet_metadata_value", { assetId, key, value }),
	removeGarnetMetadataValue: (assetId: number, key: string, value: string) =>
		invoke<void>("remove_garnet_metadata_value", { assetId, key, value }),
	removeGarnetMetadataKey: (assetId: number, key: string) =>
		invoke<void>("remove_garnet_metadata_key", { assetId, key }),
	listGarnetMetadataValuesForKey: (key: string) =>
		invoke<ValueCount[]>("list_garnet_metadata_values_for_key", { key }),
	listPinnedSources: () => invoke<PinnedSource[]>("list_pinned_sources"),
	pinSource: (absPath: string, name?: string | null) =>
		invoke<PinnedSource>("pin_source", { absPath, name: name ?? null }),
	unpinSource: (id: number) => invoke<void>("unpin_source", { id }),
	listPlugins: () => invoke<PluginManifest[]>("list_plugins"),
	getMediaPort: () => invoke<number>("get_media_port"),
	renameAsset: (assetId: number, newName: string) =>
		invoke<AssetOpResult>("rename_asset", { assetId, newName }),
	moveAsset: (assetId: number, destDir: string) =>
		invoke<AssetOpResult>("move_asset", { assetId, destDir }),
	moveFile: (fromAbsPath: string, destDir: string) =>
		invoke<string>("move_file", { fromAbsPath, destDir }),
	trashAsset: (assetId: number) => invoke<TrashResult>("trash_asset", { assetId }),
	restoreFromTrash: (trashPath: string, destinationAbsPath: string) =>
		invoke<void>("restore_from_trash", { trashPath, destinationAbsPath }),
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

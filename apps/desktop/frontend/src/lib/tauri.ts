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

/** Backend app settings (settings.json). Mirrors `settings::AppSettings`.
 *  Window fields are managed by the backend; `enabled_plugins` is the
 *  user-toggled set of compiled-in plugins (null = never configured). */
export type AppSettings = {
	window_width?: number | null;
	window_height?: number | null;
	enabled_plugins?: string[] | null;
};

/** A user-created workspace. `type` selects the interior: "library" for the
 *  base filtered-view, or a plugin-provided workflow type (e.g. "texturing").
 *  `config` is opaque type-specific JSON owned by the interior. */
export type Workspace = {
	id: number;
	name: string;
	type: string;
	icon: string | null;
	config: Record<string, unknown>;
	sort_order: number;
	created_at: number;
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
	/// True for 3D files that carry at least one meaningful animation
	/// clip (isMeaningfulClip in ModelPreview). Set by the frontend
	/// thumbnailer via save_model_thumbnail. null = not yet classified
	/// — AssetThumbnail treats null as "don't bother" for its hover
	/// preview, so older cached assets need a re-render (which the
	/// detail page force-triggers on visit) before hover kicks in.
	has_animation: boolean | null;
};

export type AssetMetadata = {
	key: string;
	value: string;
};

/** One audio track in the Music Library, derived from an audio asset + its
 *  `audio.*` metadata. Field names mirror the Rust `music::Track`. */
export type MusicTrack = {
	asset_id: number;
	abs_path: string;
	title: string;
	artist: string;
	album: string;
	album_artist: string;
	track_no: number | null;
	disc_no: number | null;
	duration_secs: number | null;
	year: number | null;
	format: string | null;
	sample_rate: number | null;
	bit_depth: number | null;
	channels: number | null;
	has_cover: boolean;
};

/** An album: tracks grouped by (album_artist, album). `cover_abs_path` is a
 *  representative track used to source the cover image. */
export type MusicAlbum = {
	id: string;
	album: string;
	album_artist: string;
	year: number | null;
	track_count: number;
	total_duration_secs: number;
	cover_asset_id: number;
	cover_abs_path: string;
	tracks: MusicTrack[];
};

export type MusicLibrary = {
	albums: MusicAlbum[];
	track_count: number;
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
/** Group key used to keep matching assets contiguous in the result. The
 *  primary ORDER BY is the group key (in `group_dir`); the secondary sort is
 *  the regular `sort_by` / `sort_dir`. `none` disables grouping. */
export type AssetGroupBy =
	| "none"
	| "root"
	| "folder"
	| "format"
	| "mtime_bucket";

export type AssetQuery = {
	root_id?: number | null;
	limit?: number;
	offset?: number;
	sort_by?: AssetSortBy;
	sort_dir?: SortDir;
	group_by?: AssetGroupBy;
	group_dir?: SortDir;
	formats?: string[];
	formats_exclude?: string[];
	path_search?: string | null;
	/// Absolute folder path; scope results to assets at or beneath it. Used by
	/// catalog-backed workspaces (base Library view, Music Library plugin).
	under_path?: string | null;
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

export type CopyResult = {
	asset_id: number;
	source_abs_path: string;
	copied_abs_path: string;
	/** True if the copy landed inside a registered library root (so it'll be
	 *  indexed as a new asset). */
	still_in_library: boolean;
};

/** One (asset → new bare filename) instruction for a batch rename. */
export type RenamePair = {
	asset_id: number;
	new_name: string;
};

/** A set of byte-identical assets (same content hash). */
export type DuplicateGroup = {
	content_hash: string;
	size: number | null;
	assets: Asset[];
};

export const api = {
	loadSettings: () => invoke<AppSettings>("load_settings"),
	saveSettings: (settings: AppSettings) =>
		invoke<void>("save_settings", { settings }),
	registerLibraryRoot: (path: string) =>
		invoke<LibraryRoot>("register_library_root", { path }),
	listLibraryRoots: () => invoke<LibraryRoot[]>("list_library_roots"),
	removeLibraryRoot: (id: number) =>
		invoke<void>("remove_library_root", { id }),
	scanLibraryRoot: (id: number) => invoke<void>("scan_library_root", { id }),
	listAssets: (query: AssetQuery) =>
		invoke<AssetPage>("list_assets", { query }),
	/// Name/path search across all roots for the command palette.
	searchAssets: (query: string, limit: number) =>
		invoke<Asset[]>("search_assets", { query, limit }),
	getAsset: (id: number) => invoke<Asset>("get_asset", { id }),
	/// Stat a single on-disk file and describe it as an ephemeral asset
	/// (id = -1, not in the catalog). Backs the ad-hoc "open a loose file"
	/// flow; `root_path`/`relative_path` are the file's parent dir + name so
	/// `absPathFor` reconstructs the real path.
	describeFile: (path: string) => invoke<Asset>("describe_file", { path }),
	/// Drain the file path Garnet was launched with (double-click / "Open
	/// with Garnet"), if any. Returns it once then clears it. Null on a normal
	/// launch.
	takePendingOpen: () => invoke<string | null>("take_pending_open"),
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
		hasAnimation: boolean,
	) =>
		invoke<void>("save_model_thumbnail", {
			assetId,
			absPath,
			mtime,
			size,
			pngBase64,
			motionOnly,
			hasAnimation,
		}),
	/// Reveal the main window (created hidden so the OS never shows the
	/// unpainted webview or the static loading fallback). Called once the
	/// splash has actually painted; idempotent on the backend.
	showMainWindow: () => invoke<void>("show_main_window"),
	/// Swap the running window's icon to the gem matching an accent preset id.
	setAppIcon: (preset: string) => invoke<void>("set_app_icon", { preset }),
	getStartupTimings: () => invoke<StartupReport | null>("get_startup_timings"),
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
	listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
	createWorkspace: (name: string, type: string, icon?: string | null) =>
		invoke<Workspace>("create_workspace", {
			name,
			workspaceType: type,
			icon: icon ?? null,
		}),
	renameWorkspace: (id: number, name: string) =>
		invoke<void>("rename_workspace", { id, name }),
	updateWorkspaceConfig: (id: number, config: Record<string, unknown>) =>
		invoke<void>("update_workspace_config", { id, config }),
	/// Persist a new top-to-bottom ordering for the sidebar workspace list.
	reorderWorkspaces: (orderedIds: number[]) =>
		invoke<void>("reorder_workspaces", { orderedIds }),
	deleteWorkspace: (id: number) => invoke<void>("delete_workspace", { id }),
	listPlugins: () => invoke<PluginManifest[]>("list_plugins"),
	/// Music Library: in-scope audio assets grouped into an album/artist tree.
	listMusicLibrary: (underPath: string | null, formats: string[] | null) =>
		invoke<MusicLibrary>("list_music_library", { underPath, formats }),
	/// Resolve album art (embedded → folder cover); returns a cached PNG's
	/// absolute path (wrap in convertFileSrc) or null.
	loadAlbumArt: (absPath: string, mtime: number | null, size?: number) =>
		invoke<string | null>("load_album_art", { absPath, mtime, size }),
	/// Waveform peaks (abs-max per bucket) for an audio file; computed +
	/// cached on first call. Feeds wavesurfer's peaks-only render path.
	getAudioPeaks: (absPath: string, mtime: number | null, buckets?: number) =>
		invoke<number[]>("get_audio_peaks", { absPath, mtime, buckets }),
	/// Background-warm the peaks cache for a set of tracks so first-play is
	/// instant. Fire-and-forget; skips already-cached files.
	prewarmPeaks: (paths: string[]) => invoke<void>("prewarm_peaks", { paths }),
	// Native audio transport (Music Library). The Rust engine owns playback;
	// position/state come back as `audio:position` / `audio:state` events.
	audioLoad: (path: string, volumeDb?: number) =>
		invoke<void>("audio_load", { path, volumeDb: volumeDb ?? null }),
	audioPlay: () => invoke<void>("audio_play"),
	audioPause: () => invoke<void>("audio_pause"),
	audioSeek: (positionSeconds: number) =>
		invoke<void>("audio_seek", { positionSeconds }),
	audioStop: () => invoke<void>("audio_stop"),
	audioSetVolume: (volumeDb: number) =>
		invoke<void>("audio_set_volume", { volumeDb }),
	getMediaPort: () => invoke<number>("get_media_port"),
	renameAsset: (assetId: number, newName: string) =>
		invoke<AssetOpResult>("rename_asset", { assetId, newName }),
	/// Rename a batch of assets in one collision-safe pass. The frontend
	/// resolves the final names (e.g. from a token pattern) and hands the
	/// (id → name) pairs here.
	renameAssets: (renames: RenamePair[]) =>
		invoke<AssetOpResult[]>("rename_assets", { renames }),
	moveAsset: (assetId: number, destDir: string) =>
		invoke<AssetOpResult>("move_asset", { assetId, destDir }),
	moveFile: (fromAbsPath: string, destDir: string) =>
		invoke<string>("move_file", { fromAbsPath, destDir }),
	/// Copy an asset's file into another directory (original untouched).
	copyAsset: (assetId: number, destDir: string) =>
		invoke<CopyResult>("copy_asset", { assetId, destDir }),
	trashAsset: (assetId: number) =>
		invoke<TrashResult>("trash_asset", { assetId }),
	/// Trash an arbitrary file by path (no asset row needed). Backs copy-undo.
	trashFile: (absPath: string) =>
		invoke<TrashResult>("trash_file", { absPath }),
	restoreFromTrash: (trashPath: string, destinationAbsPath: string) =>
		invoke<void>("restore_from_trash", { trashPath, destinationAbsPath }),
	/// Every group of byte-identical assets (shared content hash, count ≥ 2).
	findDuplicates: () => invoke<DuplicateGroup[]>("find_duplicates"),
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

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

export const api = {
	registerLibraryRoot: (path: string) =>
		invoke<LibraryRoot>("register_library_root", { path }),
	listLibraryRoots: () => invoke<LibraryRoot[]>("list_library_roots"),
	removeLibraryRoot: (id: number) => invoke<void>("remove_library_root", { id }),
	scanLibraryRoot: (id: number) => invoke<ScanReport>("scan_library_root", { id }),
	listModules: () => invoke<ModuleManifest[]>("list_modules"),
};

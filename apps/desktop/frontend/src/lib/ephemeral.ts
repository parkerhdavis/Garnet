// SPDX-License-Identifier: AGPL-3.0-or-later
//! Ad-hoc ("ephemeral") file open: point Garnet at a single file outside every
//! library root and get the preview/editor surfaces on it without ingesting it
//! into the catalog. The file is described as an ephemeral `Asset` (id = -1,
//! see backend `describe_file`) and the detail/editor pages branch on
//! `isEphemeral(asset)` to swap id-only panels for an "Add to library" upsell.
//!
//! This module owns the shared bits: the route shapes, the open-file picker,
//! and the "Add to library" upgrade path. Pages reach for `isEphemeral`; entry
//! points (hotkey, sidebar, empty-state) reach for `pickFileToPreview`.

import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, type ScanReport } from "@/lib/tauri";
import { basename, dirname } from "@/lib/paths";
import { openFileDialogFilters } from "@/lib/previewFormats";

/// Hash-route for an ad-hoc preview of an absolute path.
export function ephemeralPreviewRoute(absPath: string): string {
	return `/preview?path=${encodeURIComponent(absPath)}`;
}

/// Hash-route for the ad-hoc editor on an absolute path.
export function ephemeralEditRoute(absPath: string): string {
	return `/edit?path=${encodeURIComponent(absPath)}`;
}

/// Open the OS file picker (filtered to previewable media) and, on a pick,
/// route to the ad-hoc preview. `navigate` is the router's navigate when the
/// caller lives inside the router; the global hotkey handler lives outside it,
/// so it omits `navigate` and we fall back to setting `window.location.hash`.
export async function pickFileToPreview(
	navigate?: (to: string) => void,
): Promise<void> {
	const selected = await openFileDialog({
		directory: false,
		multiple: false,
		filters: openFileDialogFilters(),
	});
	if (typeof selected !== "string") return;
	const route = ephemeralPreviewRoute(selected);
	if (navigate) navigate(route);
	else window.location.hash = `#${route}`;
}

/// The "Add to library" upgrade path: register the file's parent folder as a
/// library root, scan it, and resolve the now-indexed file to its real catalog
/// id so the caller can route to `/asset/:id` and light up tags/metadata.
///
/// Registering a root indexes the whole folder — a deliberate, user-initiated
/// side effect (Garnet never grows the catalog on its own), so callers should
/// confirm first. Resolves to the new asset id; rejects on registration error
/// or if the scan doesn't surface the file within the timeout.
export async function addPathToLibrary(absPath: string): Promise<number> {
	const dir = dirname(absPath);
	if (!dir) throw new Error("Couldn't determine the file's parent folder.");

	const root = await api.registerLibraryRoot(dir);
	const name = basename(absPath);

	// The file sits directly in the registered folder, so its relative_path
	// is exactly its filename. Match on that (robust to path canonicalization
	// that registerLibraryRoot applies to the root).
	const resolve = async (): Promise<number | null> => {
		const page = await api.listAssets({
			root_id: root.id,
			path_search: name,
			limit: 200,
		});
		const match = page.assets.find((a) => a.relative_path === name);
		return match ? match.id : null;
	};

	return await new Promise<number>((resolvePromise, rejectPromise) => {
		let settled = false;
		let unlisten: (() => void) | null = null;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unlisten?.();
			fn();
		};
		const timer = setTimeout(() => {
			finish(() =>
				rejectPromise(
					new Error("Timed out waiting for the library to index this file."),
				),
			);
		}, 60_000);

		const tryResolve = async () => {
			try {
				const id = await resolve();
				if (id !== null) finish(() => resolvePromise(id));
			} catch (e) {
				finish(() =>
					rejectPromise(e instanceof Error ? e : new Error(String(e))),
				);
			}
		};

		// A scan that covers this root may complete and index the file.
		void listen<ScanReport>("scan:completed", (e) => {
			if (e.payload.root_id === root.id) void tryResolve();
		}).then((u) => {
			unlisten = u;
			if (settled) u();
		});

		// register_library_root does not auto-scan — kick one off. The
		// post-scan resolve also covers the case where the folder was already
		// a root and the file is already indexed.
		void api
			.scanLibraryRoot(root.id)
			.then(tryResolve)
			.catch((e) =>
				finish(() =>
					rejectPromise(e instanceof Error ? e : new Error(String(e))),
				),
			);
	});
}

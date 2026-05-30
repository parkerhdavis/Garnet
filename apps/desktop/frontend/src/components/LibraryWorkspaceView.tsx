// SPDX-License-Identifier: AGPL-3.0-or-later
//! The interior of a "library"-type workspace: a named library view seeded
//! with an optional saved filter. The depth of generic workspace furnishings
//! (filter-rule editors, manual/automatic asset membership) is deferred — this
//! is the minimal-but-real version: enter applies the saved filter, and a
//! single action snapshots the current FilterBar state back into the workspace.

import { useEffect } from "react";
import { HiBookmark, HiBookmarkSlash } from "react-icons/hi2";
import { LibraryBrowser } from "@/components/LibraryBrowser";
import type { Workspace } from "@/lib/tauri";
import {
	EMPTY_LIBRARY_QUERY,
	type SavedLibraryQuery,
	useAssetsStore,
} from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useWorkspacesStore } from "@/stores/workspacesStore";

/// Read the saved query off a workspace's opaque config, if present.
function savedQueryOf(workspace: Workspace): SavedLibraryQuery | null {
	const q = workspace.config?.savedQuery;
	return q && typeof q === "object" ? (q as SavedLibraryQuery) : null;
}

export function LibraryWorkspaceView({ workspace }: { workspace: Workspace }) {
	const applyFilters = useAssetsStore((s) => s.applyFilters);
	const refreshRoots = useLibraryStore((s) => s.refresh);
	const updateConfig = useWorkspacesStore((s) => s.updateConfig);
	const hasSavedFilter = savedQueryOf(workspace) !== null;

	useEffect(() => {
		void refreshRoots();
	}, [refreshRoots]);

	// Apply this workspace's saved filter on enter; reset to a clean slate on
	// leave so the workspace's filter doesn't leak into the global library view.
	// Keyed on workspace.id so switching workspaces re-applies.
	useEffect(() => {
		void applyFilters(savedQueryOf(workspace) ?? EMPTY_LIBRARY_QUERY);
		return () => {
			void applyFilters(EMPTY_LIBRARY_QUERY);
		};
		// Re-run when the workspace identity changes, not on every config tweak.
	}, [workspace.id, applyFilters]);

	async function handleSaveFilter() {
		const savedQuery = useAssetsStore.getState().snapshotFilters();
		await updateConfig(workspace.id, { ...workspace.config, savedQuery });
	}

	async function handleClearFilter() {
		const next = { ...workspace.config };
		delete next.savedQuery;
		await updateConfig(workspace.id, next);
		void applyFilters(EMPTY_LIBRARY_QUERY);
	}

	return (
		<div className="flex-1 min-h-0 flex flex-col min-w-0">
			<header className="px-4 py-2.5 border-b border-base-300 bg-base-100 flex items-center gap-3 shrink-0">
				<div className="min-w-0 flex-1">
					<h1 className="text-sm font-semibold truncate leading-tight">
						{workspace.name}
					</h1>
					<div className="text-[11px] text-base-content/55">
						{hasSavedFilter ? "Saved filter applied" : "Library workspace"}
					</div>
				</div>
				{hasSavedFilter && (
					<button
						type="button"
						className="btn btn-xs btn-ghost"
						onClick={() => void handleClearFilter()}
					>
						<HiBookmarkSlash className="size-3.5" />
						Clear saved filter
					</button>
				)}
				<button
					type="button"
					className="btn btn-xs"
					onClick={() => void handleSaveFilter()}
					title="Snapshot the current filter bar into this workspace"
				>
					<HiBookmark className="size-3.5" />
					{hasSavedFilter ? "Update filter" : "Save current filter"}
				</button>
			</header>

			<LibraryBrowser />
		</div>
	);
}

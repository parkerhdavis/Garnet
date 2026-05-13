// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { HiFolderPlus } from "react-icons/hi2";
import { AssetGrid } from "@/components/AssetGrid";
import { AssetList } from "@/components/AssetList";
import { DetailsSidebar } from "@/components/DetailsSidebar";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import type { Asset } from "@/lib/tauri";
import { useAssetsStore, PAGE_SIZE } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

export function LibraryPage() {
	const {
		assets,
		total,
		loading,
		error,
		viewMode,
		page,
		sortBy,
		sortDir,
		selectedId,
		setPage,
		setSort,
		select,
		refresh,
	} = useAssetsStore();
	const { roots, refresh: refreshRoots, loading: rootsLoading } = useLibraryStore();
	const navigate = useNavigate();

	useEffect(() => {
		void refreshRoots();
	}, [refreshRoots]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const noRoots = !rootsLoading && roots.length === 0;
	const selected = selectedId !== null ? assets.find((a) => a.id === selectedId) ?? null : null;

	function openAsset(asset: Asset) {
		navigate(`/asset/${asset.id}`);
	}

	return (
		<div className="flex-1 flex min-w-0">
			<div className="flex-1 flex flex-col min-w-0">
				<FilterBar />

				{error && (
					<div className="alert alert-error mx-6 mt-4">
						<span>{error}</span>
					</div>
				)}

				<div className="flex-1 min-h-0 overflow-auto">
					{noRoots ? (
						<EmptyNoRoots />
					) : loading && assets.length === 0 ? (
						<div className="p-12 text-center text-base-content/60">Loading…</div>
					) : assets.length === 0 ? (
						<EmptyNoMatches />
					) : viewMode === "grid" ? (
						<AssetGrid
							assets={assets}
							selectedId={selectedId}
							onSelect={select}
							onOpen={openAsset}
						/>
					) : (
						<AssetList
							assets={assets}
							sortBy={sortBy}
							sortDir={sortDir}
							selectedId={selectedId}
							onSort={setSort}
							onSelect={select}
							onOpen={openAsset}
						/>
					)}
				</div>

				<Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
			</div>

			{selected && (
				<DetailsSidebar asset={selected} onClose={() => select(null)} />
			)}
		</div>
	);
}

function EmptyNoRoots() {
	return (
		<div className="p-12">
			<div className="card bg-base-100 border border-base-300 max-w-xl mx-auto">
				<div className="card-body items-center text-center py-12">
					<h2 className="card-title">No library roots yet</h2>
					<p className="text-base-content/70 max-w-md">
						Garnet indexes files where they already live. Add a folder in Settings to
						start cataloging.
					</p>
					<Link to="/settings" className="btn btn-primary mt-4">
						<HiFolderPlus className="size-4" />
						Go to Settings
					</Link>
				</div>
			</div>
		</div>
	);
}

function EmptyNoMatches() {
	return (
		<div className="p-12 text-center text-base-content/60">
			No assets match the current filters.
		</div>
	);
}

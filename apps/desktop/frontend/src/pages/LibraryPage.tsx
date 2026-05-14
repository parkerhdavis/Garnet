// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { motion } from "motion/react";
import { Link, useNavigate } from "react-router-dom";
import { HiFolderPlus } from "react-icons/hi2";
import { AssetGrid } from "@/components/AssetGrid";
import { AssetList } from "@/components/AssetList";
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
		setPage,
		setSort,
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

	function openAsset(asset: Asset) {
		navigate(`/asset/${asset.id}`);
	}

	return (
		// `min-h-0` is what allows the inner `overflow-auto` pane to actually
		// scroll. Without it, this div's implicit `min-height: auto` (which
		// CSS gives every flex item) forces it as tall as its content — the
		// asset grid stretches it past the viewport, the sidebar/footer get
		// clipped, and nothing scrolls. `flex-1` alone isn't enough.
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="flex-1 min-h-0 flex flex-col min-w-0"
		>
			<FilterBar />

			{error && (
				<div className="alert alert-error mx-6 mt-4 text-sm">
					<span>{error}</span>
				</div>
			)}

			<div className="flex-1 min-h-0 overflow-auto">
				{noRoots ? (
					<EmptyNoRoots />
				) : loading && assets.length === 0 ? (
					<div className="p-12 text-center text-base-content/60 text-sm">Loading…</div>
				) : assets.length === 0 ? (
					<EmptyNoMatches />
				) : viewMode === "grid" ? (
					<AssetGrid assets={assets} onOpen={openAsset} />
				) : (
					<AssetList
						assets={assets}
						sortBy={sortBy}
						sortDir={sortDir}
						onSort={setSort}
						onOpen={openAsset}
					/>
				)}
			</div>

			<Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
		</motion.div>
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

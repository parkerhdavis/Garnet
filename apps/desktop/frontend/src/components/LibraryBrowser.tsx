// SPDX-License-Identifier: AGPL-3.0-or-later
//! The library browse surface: filter bar + asset grid/list + empty states,
//! reading the global assetsStore. Shared between the main library route
//! (LibraryPage, which layers route-derived filters on top) and a Library
//! workspace (LibraryWorkspaceView, which layers a saved filter on top).

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Link, useNavigate } from "react-router-dom";
import { HiDocumentArrowUp, HiFolderPlus, HiXMark } from "react-icons/hi2";
import { AssetGrid } from "@/components/AssetGrid";
import { AssetList } from "@/components/AssetList";
import { FilterBar } from "@/components/FilterBar";
import { pickFileToPreview } from "@/lib/ephemeral";
import type { Asset } from "@/lib/tauri";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

export function LibraryBrowser() {
	const {
		assets,
		total,
		loading,
		loadingMore,
		resetNonce,
		loadMore,
		error,
		viewMode,
		sortBy,
		sortDir,
		setSort,
	} = useAssetsStore();
	const { roots, loading: rootsLoading } = useLibraryStore();
	const navigate = useNavigate();

	const noRoots = !rootsLoading && roots.length === 0;
	const hasMore = assets.length < total;

	// Infinite scroll: a sentinel just past the last asset, watched by an
	// IntersectionObserver rooted on the scroll pane. When it enters view (plus
	// a prefetch margin), `nearBottom` flips and the effect below streams in the
	// next page — repeating as the list grows until the sentinel scrolls out of
	// range or the library is exhausted. Replaces the old Prev/Next strip.
	const scrollRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const [nearBottom, setNearBottom] = useState(false);

	useEffect(() => {
		const root = scrollRef.current;
		const sentinel = sentinelRef.current;
		if (!root || !sentinel) return;
		const obs = new IntersectionObserver(
			(entries) => setNearBottom(entries[0]?.isIntersecting ?? false),
			{ root, rootMargin: "800px 0px" },
		);
		obs.observe(sentinel);
		return () => obs.disconnect();
	}, []);

	useEffect(() => {
		if (nearBottom && hasMore && !loading && !loadingMore) void loadMore();
	}, [nearBottom, hasMore, loading, loadingMore, assets.length, loadMore]);

	// Jump back to the top whenever the query is reset (a filter/sort change),
	// so a new result set starts from the first row rather than wherever the
	// previous (now-replaced) list happened to be scrolled.
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: 0 });
	}, [resetNonce]);

	function openAsset(asset: Asset) {
		navigate(`/asset/${asset.id}`);
	}

	function handleOpenFile() {
		void pickFileToPreview((to) => navigate(to));
	}

	return (
		// `min-h-0` is what allows the inner `overflow-auto` pane to actually
		// scroll. Without it, this div's implicit `min-height: auto` (which CSS
		// gives every flex item) forces it as tall as its content.
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="flex-1 min-h-0 flex flex-col min-w-0"
		>
			<FilterBar />

			{error && (
				<div className="alert alert-error mx-6 mt-4 text-sm">
					<span className="flex-1">{error}</span>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square"
						aria-label="Dismiss"
						onClick={() => useAssetsStore.setState({ error: null })}
					>
						<HiXMark className="size-4" />
					</button>
				</div>
			)}

			<div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
				{noRoots ? (
					<EmptyNoRoots onOpenFile={handleOpenFile} />
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

				{/* Infinite-scroll sentinel + spinner. Kept just inside the
				    scroll pane so the observer's prefetch margin can reach it. */}
				<div ref={sentinelRef} aria-hidden className="h-px" />
				{loadingMore && (
					<div className="flex justify-center py-4" aria-live="polite">
						<span className="loading loading-spinner loading-sm text-base-content/50" />
					</div>
				)}
			</div>
		</motion.div>
	);
}

function EmptyNoRoots({ onOpenFile }: { onOpenFile: () => void }) {
	return (
		<div className="p-12">
			<div className="card bg-base-100 border border-base-300 max-w-xl mx-auto">
				<div className="card-body items-center text-center py-12">
					<h2 className="card-title">No library roots yet</h2>
					<p className="text-base-content/70 max-w-md">
						Garnet indexes files where they already live. Add a folder in Settings to
						start cataloging — or open a single file ad-hoc without adding it.
					</p>
					<div className="flex flex-wrap items-center justify-center gap-2 mt-4">
						<Link to="/settings" className="btn btn-primary">
							<HiFolderPlus className="size-4" />
							Go to Settings
						</Link>
						<button type="button" className="btn btn-ghost" onClick={onOpenFile}>
							<HiDocumentArrowUp className="size-4" />
							Open a file
						</button>
					</div>
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

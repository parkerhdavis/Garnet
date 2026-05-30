// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { LibraryBrowser } from "@/components/LibraryBrowser";
import { parseTypeKind } from "@/lib/typeFilters";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

export function LibraryPage() {
	const setPinnedSourceId = useAssetsStore((s) => s.setPinnedSourceId);
	const setTypeKind = useAssetsStore((s) => s.setTypeKind);
	const refreshRoots = useLibraryStore((s) => s.refresh);
	const params = useParams<{ id?: string; kind?: string }>();

	useEffect(() => {
		void refreshRoots();
	}, [refreshRoots]);

	// Single source of truth for route-derived filters: the LibraryPage reads
	// the URL params it was mounted at and applies the corresponding store
	// filter. At `/`, `params.id` is undefined → null → no filter ("All
	// Sources"). At `/sources/:id`, the route's :id resolves the pinned-source
	// filter. Same component handles both routes, so navigation between them
	// doesn't remount and the StrictMode setup/cleanup dance can't introduce
	// the spurious "clear filter" refresh that the earlier SourcePage wrapper
	// hit (which left the library briefly filtered then empty).
	useEffect(() => {
		const n = params.id ? Number(params.id) : null;
		void setPinnedSourceId(Number.isFinite(n) ? n : null);
	}, [params.id, setPinnedSourceId]);

	// `/types/:kind` mounts the same LibraryPage; the kind URL param selects
	// the active type filter (Images/Videos/Audio/Models/Animations/Other).
	// When :kind is absent (`/` or `/sources/:id`), the type filter clears.
	useEffect(() => {
		void setTypeKind(parseTypeKind(params.kind));
	}, [params.kind, setTypeKind]);

	return <LibraryBrowser />;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! `/sources/:id` — renders the standard LibraryPage with the assetsStore
//! pre-scoped to the named pinned source. The store's filter is set on mount
//! / id-change and cleared on unmount so subsequent navigation away from the
//! Sources section (back to the all-assets view, into Settings, etc.) sees
//! everything again.

import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { LibraryPage } from "@/pages/LibraryPage";
import { useAssetsStore } from "@/stores/assetsStore";

export function SourcePage() {
	const { id } = useParams<{ id: string }>();
	const setPinnedSourceId = useAssetsStore((s) => s.setPinnedSourceId);

	useEffect(() => {
		const n = Number(id);
		void setPinnedSourceId(Number.isFinite(n) ? n : null);
	}, [id, setPinnedSourceId]);

	// Clear the filter on actual unmount (not on id-change) so navigating to
	// a different route in the sidebar doesn't carry the pin forward. Mount-
	// only effect — deps don't include `id`.
	useEffect(() => {
		return () => {
			void setPinnedSourceId(null);
		};
	}, [setPinnedSourceId]);

	return <LibraryPage />;
}

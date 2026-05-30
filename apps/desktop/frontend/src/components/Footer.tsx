// SPDX-License-Identifier: AGPL-3.0-or-later
//! Global app footer. Always visible at the bottom of Layout.
//!
//! Shows **background task status** when any tasks are active (a caption +
//! spinner for thumbnail generation, library scans, future plugin work).
//! Otherwise, on library-style routes (`/`, `/sources/:id`, `/types/:kind`),
//! the total **asset count** for the active filter; "Ready" when idle. The
//! browse pane loads results via infinite scroll, so there are no page controls
//! here.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAssetsStore } from "@/stores/assetsStore";
import { useBgTasksStore, type BgTaskKind } from "@/stores/bgTasksStore";

/// How long a background task must run before its indicator appears. Quick
/// scans (cold-cache misses, no-op file-watcher rescans) finish below this
/// threshold and never show — they're not worth flashing the footer for.
const SHOW_DELAY_MS = 300;
/// Once the indicator is showing, keep it visible at least this long after
/// activity ceases. Smooths out the "scan finishes → next debounced scan
/// fires 200 ms later" pattern that otherwise toggles the footer rapidly.
const MIN_VISIBLE_MS = 800;

function useIsLibraryRoute(): boolean {
	const { pathname } = useLocation();
	if (pathname === "/") return true;
	if (pathname.startsWith("/sources/")) return true;
	if (pathname.startsWith("/types/")) return true;
	return false;
}

function pluralize(n: number, singular: string, plural?: string): string {
	return n === 1 ? singular : (plural ?? `${singular}s`);
}

/// Wraps a boolean "something is happening" signal with on-delay and
/// min-visible duration so the UI doesn't flicker on sub-second tasks.
function useSmoothedActive(active: boolean): boolean {
	const [shown, setShown] = useState(false);
	const shownAtRef = useRef<number | null>(null);

	useEffect(() => {
		if (active) {
			if (shown) return;
			const t = window.setTimeout(() => {
				setShown(true);
				shownAtRef.current = performance.now();
			}, SHOW_DELAY_MS);
			return () => window.clearTimeout(t);
		}
		if (!shown) return;
		const visibleFor = performance.now() - (shownAtRef.current ?? 0);
		const remaining = Math.max(0, MIN_VISIBLE_MS - visibleFor);
		const t = window.setTimeout(() => {
			setShown(false);
			shownAtRef.current = null;
		}, remaining);
		return () => window.clearTimeout(t);
	}, [active, shown]);

	return shown;
}

function summarize(byKind: Map<BgTaskKind, number>): string {
	const parts: string[] = [];
	const thumbs = byKind.get("thumbnail") ?? 0;
	const models = byKind.get("model-thumbnail") ?? 0;
	const scans = byKind.get("scan") ?? 0;
	const other = byKind.get("other") ?? 0;
	const totalThumbs = thumbs + models;
	if (totalThumbs > 0)
		parts.push(`${totalThumbs} ${pluralize(totalThumbs, "thumbnail")}`);
	if (scans > 0) parts.push(`${scans} ${pluralize(scans, "scan")}`);
	if (other > 0) parts.push(`${other} ${pluralize(other, "task")}`);
	if (parts.length === 0) return "";
	return `Working on ${parts.join(", ")}…`;
}

export function Footer() {
	const tasks = useBgTasksStore((s) => s.tasks);
	const total = useAssetsStore((s) => s.total);
	const isLibraryRoute = useIsLibraryRoute();

	const byKind = new Map<BgTaskKind, number>();
	for (const t of tasks.values()) {
		byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
	}
	const caption = summarize(byKind);
	const active = useSmoothedActive(tasks.size > 0);
	// Hold the last non-empty caption so the label doesn't blank out during
	// the MIN_VISIBLE_MS coast after the underlying task count hits zero.
	const lastCaptionRef = useRef("Working…");
	if (caption) lastCaptionRef.current = caption;
	const displayedCaption = caption || lastCaptionRef.current;

	return (
		<div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-base-100 border-t border-base-300 text-xs min-h-9">
			<div className="flex-1 min-w-0 flex items-center gap-3">
				{active ? (
					<>
						<span
							className="loading loading-spinner loading-xs text-primary shrink-0"
							aria-hidden="true"
						/>
						<span
							className="text-base-content/80 truncate"
							title={displayedCaption}
						>
							{displayedCaption}
						</span>
					</>
				) : isLibraryRoute && total > 0 ? (
					<span className="text-base-content/55 tabular-nums">
						{total.toLocaleString()} {pluralize(total, "asset")}
					</span>
				) : (
					<span className="text-base-content/40">Ready</span>
				)}
			</div>
		</div>
	);
}

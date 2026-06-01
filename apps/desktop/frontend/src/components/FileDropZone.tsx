// SPDX-License-Identifier: AGPL-3.0-or-later
//! Window-level drag-and-drop for ad-hoc file open. When a file is dragged from
//! the OS file manager onto the Garnet window, we show a "Drop to open" overlay
//! and, on drop, open the first previewable file ad-hoc (ephemeral preview, no
//! catalog ingestion — same path as Cmd/Ctrl+O). Requires `dragDropEnabled` in
//! tauri.conf so Tauri delivers native drop events with file paths (rather than
//! letting the webview's HTML5 DnD swallow them).
//!
//! Mounted once at the app root, outside the router, so `openPathAdHoc` falls
//! back to setting `window.location.hash`.

import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { HiArrowDownTray } from "react-icons/hi2";
import { openPathAdHoc } from "@/lib/ephemeral";
import { allPreviewableExts } from "@/lib/previewFormats";

const PREVIEWABLE = new Set(allPreviewableExts());

function extOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/// Prefer the first path Garnet can actually preview; fall back to the first
/// path so an unknown type still lands on the ephemeral page (which degrades
/// gracefully) rather than silently doing nothing.
function pickTarget(paths: string[]): string | null {
	if (paths.length === 0) return null;
	return paths.find((p) => PREVIEWABLE.has(extOf(p))) ?? paths[0];
}

export function FileDropZone() {
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void getCurrentWebview()
			.onDragDropEvent((event) => {
				const p = event.payload;
				if (p.type === "enter" || p.type === "over") {
					setDragging(true);
				} else if (p.type === "leave") {
					setDragging(false);
				} else if (p.type === "drop") {
					setDragging(false);
					const target = pickTarget(p.paths);
					if (target) openPathAdHoc(target);
				}
			})
			.then((u) => {
				unlisten = u;
			})
			.catch(() => {});
		return () => unlisten?.();
	}, []);

	if (!dragging) return null;

	return (
		<div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-base-300/40 backdrop-blur-sm">
			<div className="m-6 flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary/70 bg-base-100/80 py-16 text-primary">
				<HiArrowDownTray className="size-10" />
				<p className="text-lg font-semibold">Drop to open</p>
				<p className="text-sm text-base-content/60">
					Preview a file without adding it to your library
				</p>
			</div>
		</div>
	);
}

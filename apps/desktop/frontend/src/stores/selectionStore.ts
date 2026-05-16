// SPDX-License-Identifier: AGPL-3.0-or-later
//! Multi-select state for the asset grid/list. The visible "selected"
//! state of a tile, and the source of truth for any future multi-asset
//! context actions (trash all, refresh thumbnails for all, etc.).
//!
//! Standard file-manager click semantics:
//!   - Plain click → replace selection with this asset
//!   - Ctrl/Cmd+click → toggle this asset in/out of selection
//!   - Shift+click → range-select from the anchor (typically the
//!     most-recent plain-click) through the clicked asset, given an
//!     ordered list of currently-visible IDs
//!   - Double-click → open (selection unchanged)
//!
//! `anchor` is the asset most recently used as the "I clicked here"
//! reference for a future shift-range. Plain click and toggle both move
//! the anchor; shift-click leaves it alone (so successive shift-clicks
//! expand/contract the range against the same anchor, like Finder).

import { create } from "zustand";

type SelectionState = {
	ids: Set<number>;
	anchor: number | null;
	/// Replace the entire selection with a single id.
	replace: (id: number) => void;
	/// Replace selection with a list of ids (e.g. from a shift-range).
	/// Anchor is preserved.
	replaceMany: (ids: number[]) => void;
	/// Add/remove a single id; moves the anchor to the toggled id.
	toggle: (id: number) => void;
	/// Compute a range using the supplied ordered ids and the current
	/// anchor; falls back to a single-asset selection if no anchor exists.
	selectRange: (toId: number, orderedIds: number[]) => void;
	clear: () => void;
};

export const useSelectionStore = create<SelectionState>((set, get) => ({
	ids: new Set<number>(),
	anchor: null,

	replace: (id) =>
		set({
			ids: new Set([id]),
			anchor: id,
		}),

	replaceMany: (ids) =>
		set((s) => ({
			ids: new Set(ids),
			anchor: s.anchor,
		})),

	toggle: (id) =>
		set((s) => {
			const next = new Set(s.ids);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return { ids: next, anchor: id };
		}),

	selectRange: (toId, orderedIds) => {
		const { anchor } = get();
		if (anchor === null) {
			set({ ids: new Set([toId]), anchor: toId });
			return;
		}
		const anchorIdx = orderedIds.indexOf(anchor);
		const toIdx = orderedIds.indexOf(toId);
		if (anchorIdx === -1 || toIdx === -1) {
			set({ ids: new Set([toId]), anchor: toId });
			return;
		}
		const [start, end] =
			anchorIdx <= toIdx ? [anchorIdx, toIdx] : [toIdx, anchorIdx];
		const range = orderedIds.slice(start, end + 1);
		set({ ids: new Set(range), anchor }); // anchor unchanged
	},

	clear: () => set({ ids: new Set(), anchor: null }),
}));

/// Convenience selector that returns a memoizable boolean — Zustand re-runs
/// selectors on every render, so deriving has() inline in a component
/// works but means the component subscribes to *every* selection change.
/// Use this helper to subscribe to only this asset's selected state.
export function useIsSelected(id: number): boolean {
	return useSelectionStore((s) => s.ids.has(id));
}

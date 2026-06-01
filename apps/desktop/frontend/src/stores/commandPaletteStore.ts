// SPDX-License-Identifier: AGPL-3.0-or-later
//! Open/closed state for the Ctrl+K command palette. Tiny global store so the
//! App-level hotkey can toggle it from anywhere while the overlay (mounted in
//! Layout) renders off it.

import { create } from "zustand";

type State = {
	open: boolean;
	openPalette: () => void;
	close: () => void;
	toggle: () => void;
};

export const useCommandPaletteStore = create<State>((set) => ({
	open: false,
	openPalette: () => set({ open: true }),
	close: () => set({ open: false }),
	toggle: () => set((s) => ({ open: !s.open })),
}));

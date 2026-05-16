// SPDX-License-Identifier: AGPL-3.0-or-later
//! Tracks whether the app has finished its "startup" phase. The splash
//! masks the boot window — DB open, watcher init, initial scans dispatched
//! from main.rs, the React tree mounting, the first asset list fetch — and
//! flipping `ready` is the signal that all of that has settled and the user
//! is now looking at the real UI.
//!
//! The point of this gate isn't to delay work that's *necessary* for the
//! app to function (startup tasks should run behind the splash, where the
//! user is already expecting to wait). It's to defer *background* tasks
//! that improve UX over time but aren't needed to call the app "ready":
//! thumbnail generation, incremental indexing, etc. Holding those off
//! until ready keeps cold-launch from competing with the work the splash
//! is paid to mask.
//!
//! Force-paths (detail-page open, right-click Refresh, etc.) intentionally
//! bypass this and dispatch immediately, since they're explicit user
//! actions that wouldn't make sense to silently queue.

import { create } from "zustand";

type BootState = {
	/// True once the splash has fully dismissed.
	ready: boolean;
	markReady: () => void;
};

export const useBootStore = create<BootState>((set) => ({
	ready: false,
	markReady: () => set((s) => (s.ready ? s : { ready: true })),
}));

/// Resolves immediately if the app has finished booting, or on the next
/// `markReady()` otherwise. Use in async effects whose work should run as a
/// background task rather than a startup task.
export function awaitBootReady(): Promise<void> {
	if (useBootStore.getState().ready) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const unsub = useBootStore.subscribe((s) => {
			if (s.ready) {
				unsub();
				resolve();
			}
		});
	});
}

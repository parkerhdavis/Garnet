// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared registry of "things happening in the background." Anything that
//! wants to be visible in the global footer (thumbnail generation, library
//! scans, future plugin work, etc.) adds a task here when it starts and
//! removes it when it finishes — the Footer reads the live state and shows
//! a caption + progress bar.
//!
//! Tasks are keyed by an id so adds are idempotent: the same task added
//! from multiple call sites collapses into one entry. That matches the
//! reality of e.g. thumbnail generation, where a single backend job may be
//! awaited by 60 components but is one piece of work.

import { create } from "zustand";

export type BgTaskKind = "thumbnail" | "scan" | "model-thumbnail" | "other";

export type BgTask = {
	id: string;
	kind: BgTaskKind;
	/// Optional human-readable label, surfaced in tooltips / future expanded
	/// task views. The footer summary derives its caption from `kind` counts.
	label?: string;
};

type BgTasksState = {
	tasks: Map<string, BgTask>;
	add: (task: BgTask) => void;
	remove: (id: string) => void;
};

export const useBgTasksStore = create<BgTasksState>((set) => ({
	tasks: new Map(),
	add: (task) =>
		set((s) => {
			if (s.tasks.has(task.id)) return s;
			const next = new Map(s.tasks);
			next.set(task.id, task);
			return { tasks: next };
		}),
	remove: (id) =>
		set((s) => {
			if (!s.tasks.has(id)) return s;
			const next = new Map(s.tasks);
			next.delete(id);
			return { tasks: next };
		}),
}));

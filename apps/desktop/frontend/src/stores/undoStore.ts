// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application-wide undo/redo history. Mirrors the model used in Packi's
//! `undoStore`: a stack of `UndoableAction` closures with a paired stack for
//! redo. Operations call `push({ description, undo, redo })` after performing
//! the action; the global Ctrl+Z handler and the UI buttons drive the stacks.
//!
//! Why closures (and not a serializable action log): the actions are async
//! IPC calls against Tauri commands whose arguments may not survive a
//! reload. Keeping the closures in memory only is fine for V1 — undo history
//! does not need to outlive the session.

import { create } from "zustand";

const MAX_HISTORY = 100;

export interface UndoableAction {
	description: string;
	timestamp: number;
	undo: () => void | Promise<void>;
	redo: () => void | Promise<void>;
}

interface UndoState {
	undoStack: UndoableAction[];
	redoStack: UndoableAction[];
	canUndo: boolean;
	canRedo: boolean;
	/** True while an undo or redo is mid-flight, so the UI can disable
	 *  controls and the hotkey can ignore extra presses. */
	busy: boolean;
	/** Push a freshly-performed action onto the undo stack. Clears redo. */
	push: (action: Omit<UndoableAction, "timestamp">) => void;
	undo: () => Promise<void>;
	redo: () => Promise<void>;
	clear: () => void;
}

export const useUndoStore = create<UndoState>((set, get) => ({
	undoStack: [],
	redoStack: [],
	canUndo: false,
	canRedo: false,
	busy: false,

	push: (partial) => {
		const action: UndoableAction = { ...partial, timestamp: Date.now() };
		const { undoStack } = get();
		const updated = [...undoStack, action];
		const capped =
			updated.length > MAX_HISTORY
				? updated.slice(updated.length - MAX_HISTORY)
				: updated;
		set({
			undoStack: capped,
			redoStack: [],
			canUndo: true,
			canRedo: false,
		});
	},

	undo: async () => {
		const { undoStack, redoStack, busy } = get();
		if (busy || undoStack.length === 0) return;
		const action = undoStack[undoStack.length - 1];
		set({ busy: true });
		try {
			await action.undo();
		} catch (err) {
			console.error("Undo failed:", err);
			set({ busy: false });
			return;
		}
		const newUndo = undoStack.slice(0, -1);
		const newRedo = [...redoStack, action];
		set({
			undoStack: newUndo,
			redoStack: newRedo,
			canUndo: newUndo.length > 0,
			canRedo: true,
			busy: false,
		});
	},

	redo: async () => {
		const { undoStack, redoStack, busy } = get();
		if (busy || redoStack.length === 0) return;
		const action = redoStack[redoStack.length - 1];
		set({ busy: true });
		try {
			await action.redo();
		} catch (err) {
			console.error("Redo failed:", err);
			set({ busy: false });
			return;
		}
		const newRedo = redoStack.slice(0, -1);
		const newUndo = [...undoStack, action];
		set({
			undoStack: newUndo,
			redoStack: newRedo,
			canUndo: true,
			canRedo: newRedo.length > 0,
			busy: false,
		});
	},

	clear: () =>
		set({
			undoStack: [],
			redoStack: [],
			canUndo: false,
			canRedo: false,
		}),
}));

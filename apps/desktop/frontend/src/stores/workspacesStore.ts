// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace list backing the sidebar's Workspaces section. Mirrors the
//! pinned-sources store shape: the Rust side owns persistence, this store just
//! reflects it and exposes the mutating actions.

import { create } from "zustand";
import { api, type Workspace } from "@/lib/tauri";

type State = {
	workspaces: Workspace[];
	loading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	create: (
		name: string,
		type: string,
		icon?: string | null,
	) => Promise<Workspace | null>;
	rename: (id: number, name: string) => Promise<void>;
	updateConfig: (id: number, config: Record<string, unknown>) => Promise<void>;
	/** Apply a new order locally (no persistence) — driven by the drag. */
	setOrder: (workspaces: Workspace[]) => void;
	/** Persist the current order to the backend — called when a drag ends. */
	persistOrder: () => Promise<void>;
	remove: (id: number) => Promise<void>;
	get: (id: number) => Workspace | undefined;
};

export const useWorkspacesStore = create<State>((set, get) => ({
	workspaces: [],
	loading: true,
	error: null,

	refresh: async () => {
		set({ loading: true, error: null });
		try {
			const workspaces = await api.listWorkspaces();
			set({ workspaces, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},

	create: async (name, type, icon) => {
		set({ error: null });
		try {
			const ws = await api.createWorkspace(name, type, icon);
			await get().refresh();
			return ws;
		} catch (e) {
			set({ error: String(e) });
			return null;
		}
	},

	rename: async (id, name) => {
		set({ error: null });
		try {
			await api.renameWorkspace(id, name);
			await get().refresh();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	updateConfig: async (id, config) => {
		set({ error: null });
		try {
			await api.updateWorkspaceConfig(id, config);
			await get().refresh();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	setOrder: (workspaces) => set({ workspaces }),

	persistOrder: async () => {
		try {
			await api.reorderWorkspaces(get().workspaces.map((w) => w.id));
		} catch (e) {
			// The optimistic order is now out of sync with the backend; pull
			// the server's truth back so the list doesn't lie.
			set({ error: String(e) });
			await get().refresh();
		}
	},

	remove: async (id) => {
		set({ error: null });
		try {
			await api.deleteWorkspace(id);
			await get().refresh();
		} catch (e) {
			set({ error: String(e) });
		}
	},

	get: (id) => get().workspaces.find((w) => w.id === id),
}));

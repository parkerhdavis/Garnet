// SPDX-License-Identifier: AGPL-3.0-or-later
//! Tracks which compiled-in plugins are enabled. Source of truth is the
//! backend `AppSettings.enabled_plugins` (settings.json); this store mirrors it
//! and writes back on toggle (load-modify-save so it never clobbers the
//! window-size fields the backend manages).
//!
//! The built-in `core` pseudo-plugin is always on and is never written to
//! settings. When settings have never been configured (`enabled_plugins` is
//! null), the DEFAULT_ENABLED set applies.

import { create } from "zustand";
import { api } from "@/lib/tauri";
import {
	allAutomationSteps,
	allGlobals,
	allWorkflows,
} from "@/plugins/registry";
import type {
	AutomationStepContribution,
	WorkflowContribution,
} from "@/plugins/types";

/// Plugins that are always enabled and never user-toggleable. `core` carries
/// the base automation steps (Rename/Resize/Convert).
const ALWAYS_ON = new Set(["core"]);

/// Applied when `enabled_plugins` is null (fresh install / never configured).
/// First-party plugins ship on so their functionality is discoverable out of
/// the box; users can disable any of them from the Plugins page.
const DEFAULT_ENABLED = ["texturing", "music"];

type PluginsState = {
	/// User-configurable enabled ids (excludes always-on `core`). A new Set
	/// reference is assigned on every change so selectors re-render.
	enabledIds: Set<string>;
	loaded: boolean;
	load: () => Promise<void>;
	isEnabled: (id: string) => boolean;
	setEnabled: (id: string, enabled: boolean) => Promise<void>;
};

export const usePluginsStore = create<PluginsState>((set, get) => ({
	enabledIds: new Set(DEFAULT_ENABLED),
	loaded: false,

	load: async () => {
		try {
			const settings = await api.loadSettings();
			const ids = settings.enabled_plugins ?? DEFAULT_ENABLED;
			set({ enabledIds: new Set(ids), loaded: true });
		} catch (e) {
			console.error("Failed to load plugin settings:", e);
			set({ loaded: true });
		}
	},

	isEnabled: (id) => ALWAYS_ON.has(id) || get().enabledIds.has(id),

	setEnabled: async (id, enabled) => {
		if (ALWAYS_ON.has(id)) return; // core can't be toggled
		const next = new Set(get().enabledIds);
		if (enabled) next.add(id);
		else next.delete(id);
		set({ enabledIds: next });
		// Load-modify-save to preserve window_width/height and any other fields.
		try {
			const settings = await api.loadSettings();
			settings.enabled_plugins = [...next];
			await api.saveSettings(settings);
		} catch (e) {
			console.error("Failed to persist plugin settings:", e);
		}
	},
}));

/// Non-reactive snapshot of the workflows whose owning plugin is enabled.
/// Components that need to re-render on toggle should subscribe to
/// `usePluginsStore(s => s.enabledIds)` and call this.
export function enabledWorkflows(): WorkflowContribution[] {
	const isEnabled = usePluginsStore.getState().isEnabled;
	return allWorkflows()
		.filter((w) => isEnabled(w.pluginId))
		.map((w) => w.contribution);
}

export function enabledAutomationSteps(): AutomationStepContribution[] {
	const isEnabled = usePluginsStore.getState().isEnabled;
	return allAutomationSteps()
		.filter((s) => isEnabled(s.pluginId))
		.map((s) => s.contribution);
}

/// Always-mounted global components for enabled plugins. Components that need to
/// update on toggle should subscribe to `usePluginsStore(s => s.enabledIds)`.
export function enabledGlobals(): React.ComponentType[] {
	const isEnabled = usePluginsStore.getState().isEnabled;
	return allGlobals()
		.filter((g) => isEnabled(g.pluginId))
		.map((g) => g.contribution);
}

/// The enabled workflow for a given workspace type, or undefined if no plugin
/// provides it or the owning plugin is disabled.
export function workflowForType(type: string): WorkflowContribution | undefined {
	const isEnabled = usePluginsStore.getState().isEnabled;
	const match = allWorkflows().find(
		(w) => w.contribution.workspaceType === type && isEnabled(w.pluginId),
	);
	return match?.contribution;
}

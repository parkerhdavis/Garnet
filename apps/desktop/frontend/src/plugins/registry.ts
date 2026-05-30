// SPDX-License-Identifier: AGPL-3.0-or-later
//! The compiled-in plugin registry. Plugins register themselves at startup via
//! static-import side effects (see `src/plugins/index.ts`). This module is
//! pure data — it knows nothing about enable/disable state; that filtering
//! lives in `pluginsStore` (which reads from here), keeping the dependency
//! one-directional (store → registry).

import type {
	AutomationStepContribution,
	GarnetPlugin,
	WorkflowContribution,
} from "@/plugins/types";

/// One contribution paired with the id of the plugin that owns it — so
/// enable/disable gating can be applied downstream.
export type Owned<T> = { pluginId: string; contribution: T };

const plugins = new Map<string, GarnetPlugin>();

/// Register a compiled-in plugin. Called at import time by each plugin's
/// `index.ts`. Idempotent-ish: a duplicate id warns and overwrites (which only
/// happens under dev hot-reload, never in a normal run).
export function registerPlugin(plugin: GarnetPlugin): void {
	if (plugins.has(plugin.id)) {
		console.warn(
			`Plugin "${plugin.id}" registered more than once; overwriting.`,
		);
	}
	plugins.set(plugin.id, plugin);
}

export function allPlugins(): GarnetPlugin[] {
	return [...plugins.values()];
}

export function getPlugin(id: string): GarnetPlugin | undefined {
	return plugins.get(id);
}

export function allWorkflows(): Owned<WorkflowContribution>[] {
	const out: Owned<WorkflowContribution>[] = [];
	for (const p of plugins.values()) {
		for (const c of p.workflows ?? []) {
			out.push({ pluginId: p.id, contribution: c });
		}
	}
	return out;
}

export function allAutomationSteps(): Owned<AutomationStepContribution>[] {
	const out: Owned<AutomationStepContribution>[] = [];
	for (const p of plugins.values()) {
		for (const c of p.automationSteps ?? []) {
			out.push({ pluginId: p.id, contribution: c });
		}
	}
	return out;
}

export function allGlobals(): Owned<React.ComponentType>[] {
	const out: Owned<React.ComponentType>[] = [];
	for (const p of plugins.values()) {
		if (p.global) out.push({ pluginId: p.id, contribution: p.global });
	}
	return out;
}

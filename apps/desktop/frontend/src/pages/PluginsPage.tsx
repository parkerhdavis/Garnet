// SPDX-License-Identifier: AGPL-3.0-or-later
//! Plugin manager. Lists the compiled-in first-party plugins from the frontend
//! registry and lets the user enable/disable each one. Enabling a plugin
//! surfaces its workflow types (in the "new workspace" picker) and its
//! automation steps (in the Automations palette).
//!
//! Note: the "compiled-in" plugins here are the behavioral source of truth.
//! The Rust `list_plugins` disk-manifest path (for future third-party plugins)
//! is reconciled into this view in a later pass.

import { HiPuzzlePiece } from "react-icons/hi2";
import { allPlugins } from "@/plugins/registry";
import type { GarnetPlugin } from "@/plugins/types";
import { usePluginsStore } from "@/stores/pluginsStore";

const CORE_ID = "core";

export function PluginsPage() {
	// Subscribe to enabledIds so toggles re-render. isEnabled reads the live set.
	usePluginsStore((s) => s.enabledIds);
	const isEnabled = usePluginsStore((s) => s.isEnabled);
	const setEnabled = usePluginsStore((s) => s.setEnabled);

	// Hide the internal `core` pseudo-plugin from the manager — it's an
	// always-on implementation detail, not a user-facing plugin.
	const plugins = allPlugins().filter((p) => p.id !== CORE_ID);

	return (
		<div className="flex-1 min-h-0 overflow-auto p-6">
			<div className="max-w-3xl mx-auto">
				<header className="flex items-center gap-3 mb-6">
					<div className="size-10 rounded-lg bg-base-200 flex items-center justify-center">
						<HiPuzzlePiece className="size-5 text-base-content/70" />
					</div>
					<div>
						<h1 className="text-xl font-semibold tracking-tight">Plugins</h1>
						<p className="text-sm text-base-content/60">
							First-party plugins add per-media-type tools. Enable one to surface
							its workspace type and automation steps.
						</p>
					</div>
				</header>

				{plugins.length === 0 ? (
					<div className="card bg-base-100 border border-base-300">
						<div className="card-body items-center text-center py-10 text-base-content/55">
							<HiPuzzlePiece className="size-7 opacity-40" />
							<p className="text-sm">No plugins are bundled yet.</p>
						</div>
					</div>
				) : (
					<ul className="flex flex-col gap-3">
						{plugins.map((plugin) => (
							<PluginRow
								key={plugin.id}
								plugin={plugin}
								enabled={isEnabled(plugin.id)}
								onToggle={(next) => void setEnabled(plugin.id, next)}
							/>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function PluginRow({
	plugin,
	enabled,
	onToggle,
}: {
	plugin: GarnetPlugin;
	enabled: boolean;
	onToggle: (next: boolean) => void;
}) {
	const workflowCount = plugin.workflows?.length ?? 0;
	const stepCount = plugin.automationSteps?.length ?? 0;
	const contributions = [
		workflowCount > 0 &&
			`${workflowCount} workflow${workflowCount === 1 ? "" : "s"}`,
		stepCount > 0 &&
			`${stepCount} automation step${stepCount === 1 ? "" : "s"}`,
	].filter(Boolean) as string[];

	return (
		<li className="card bg-base-100 border border-base-300">
			<div className="card-body p-5 flex-row items-start gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h2 className="text-base font-medium truncate">{plugin.name}</h2>
						{plugin.version && (
							<span className="badge badge-ghost badge-sm">v{plugin.version}</span>
						)}
					</div>
					{plugin.description && (
						<p className="text-sm text-base-content/65 mt-1">{plugin.description}</p>
					)}
					{contributions.length > 0 && (
						<p className="text-xs text-base-content/45 mt-2">
							Contributes {contributions.join(" · ")}
						</p>
					)}
				</div>
				<label className="flex items-center gap-2 cursor-pointer shrink-0">
					<span className="text-xs text-base-content/55">
						{enabled ? "Enabled" : "Disabled"}
					</span>
					<input
						type="checkbox"
						className="toggle toggle-primary toggle-sm"
						checked={enabled}
						onChange={(e) => onToggle(e.target.checked)}
					/>
				</label>
			</div>
		</li>
	);
}

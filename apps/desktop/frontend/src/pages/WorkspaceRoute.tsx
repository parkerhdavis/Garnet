// SPDX-License-Identifier: AGPL-3.0-or-later
//! Renders a workspace's interior, dispatching on its `type`:
//!   - "library" → the base library view (minimal in this phase).
//!   - plugin type → the contributing plugin's Workflow component, or a
//!     "plugin not enabled" state if the owning plugin is disabled/absent.

import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { HiPuzzlePiece } from "react-icons/hi2";
import { LIBRARY_TYPE } from "@/lib/workspaceTypes";
import { workflowForType } from "@/stores/pluginsStore";
import { usePluginsStore } from "@/stores/pluginsStore";
import { useWorkspacesStore } from "@/stores/workspacesStore";

export function WorkspaceRoute() {
	const { id } = useParams<{ id: string }>();
	const wsId = id ? Number(id) : Number.NaN;
	const workspaces = useWorkspacesStore((s) => s.workspaces);
	const loading = useWorkspacesStore((s) => s.loading);
	const refresh = useWorkspacesStore((s) => s.refresh);
	// Re-resolve the workflow component if the user toggles a plugin.
	usePluginsStore((s) => s.enabledIds);

	useEffect(() => {
		if (workspaces.length === 0) void refresh();
	}, [workspaces.length, refresh]);

	const workspace = workspaces.find((w) => w.id === wsId);

	if (!workspace) {
		return (
			<div className="flex-1 flex items-center justify-center text-sm text-base-content/60">
				{loading ? "Loading…" : "Workspace not found."}
			</div>
		);
	}

	if (workspace.type === LIBRARY_TYPE) {
		// Minimal placeholder until the Library workspace interior lands.
		return (
			<div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">{workspace.name}</h1>
				<p className="text-sm text-base-content/60 mt-2 max-w-md">
					Library workspace interior coming up next.
				</p>
			</div>
		);
	}

	const workflow = workflowForType(workspace.type);
	if (!workflow) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
				<div className="size-16 rounded-full bg-base-100 border border-base-300 flex items-center justify-center text-base-content/40 mb-5">
					<HiPuzzlePiece className="size-7" />
				</div>
				<h1 className="text-xl font-semibold tracking-tight">{workspace.name}</h1>
				<p className="text-sm text-base-content/60 mt-2 max-w-md">
					This workspace needs the “{workspace.type}” plugin, which isn’t enabled.
				</p>
				<Link to="/functions/plugins" className="btn btn-sm btn-primary mt-5">
					Open Plugins
				</Link>
			</div>
		);
	}

	const Interior = workflow.Component;
	return <Interior workspace={workspace} />;
}

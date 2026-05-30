// SPDX-License-Identifier: AGPL-3.0-or-later
//! Context that exposes the active texturing workspace's working directories to
//! the plugin's shared UI. The DropZone reads `rootFolder` to pre-target its
//! file picker; the ExportPanel reads `outputDir` as the default export
//! location; the WorkingFilesRail reads/writes both. All values persist in the
//! workspace's `config` (DB-backed), so they survive restarts.

import { createContext, useContext, useMemo } from "react";
import type { Workspace } from "@/lib/tauri";
import {
	getFileFilters,
	getWorkflowConfig,
	getWorkingFolder,
} from "@/lib/workspaceConfig";
import { useWorkspacesStore } from "@/stores/workspacesStore";

type TexturingWorkspaceValue = {
	workspaceId: number;
	rootFolder: string | null;
	fileFilters: string | null;
	outputDir: string | null;
	setRootFolder: (path: string | null) => void;
	setOutputDir: (path: string | null) => void;
};

const TexturingWorkspaceContext = createContext<TexturingWorkspaceValue | null>(null);

/// Returns the active texturing workspace's working-dir state, or null when
/// used outside a texturing workspace (the shared UI degrades gracefully).
export function useTexturingWorkspace(): TexturingWorkspaceValue | null {
	return useContext(TexturingWorkspaceContext);
}

export function TexturingWorkspaceProvider({
	workspace,
	children,
}: {
	workspace: Workspace;
	children: React.ReactNode;
}) {
	const updateConfig = useWorkspacesStore((s) => s.updateConfig);

	const rootFolder = getWorkingFolder(workspace);
	const fileFilters = getFileFilters(workspace);
	const tx = getWorkflowConfig(workspace, "texturing");
	const outputDir = typeof tx.outputDir === "string" && tx.outputDir ? tx.outputDir : null;

	const value = useMemo<TexturingWorkspaceValue>(
		() => ({
			workspaceId: workspace.id,
			rootFolder,
			fileFilters,
			outputDir,
			setRootFolder: (path) => {
				void updateConfig(workspace.id, {
					...workspace.config,
					rootFolder: path ?? undefined,
				});
			},
			setOutputDir: (path) => {
				void updateConfig(workspace.id, {
					...workspace.config,
					texturing: {
						...getWorkflowConfig(workspace, "texturing"),
						outputDir: path ?? undefined,
					},
				});
			},
		}),
		[workspace, rootFolder, fileFilters, outputDir, updateConfig],
	);

	return (
		<TexturingWorkspaceContext.Provider value={value}>
			{children}
		</TexturingWorkspaceContext.Provider>
	);
}

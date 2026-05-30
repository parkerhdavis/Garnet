// SPDX-License-Identifier: AGPL-3.0-or-later
//! Settings for an existing workspace: rename it and (for workflow types that
//! use a working folder) edit the working folder + file filters. Opened from
//! the sidebar workspace right-click menu.

import { useEffect, useState } from "react";
import { WorkingFolderFields } from "@/components/WorkingFolderFields";
import type { Workspace } from "@/lib/tauri";
import { getFileFilters, getWorkingFolder } from "@/lib/workspaceConfig";
import { workspaceTypeMeta } from "@/lib/workspaceTypes";
import { useWorkspacesStore } from "@/stores/workspacesStore";

export function WorkspaceSettingsDialog({
	workspace,
	onClose,
}: {
	workspace: Workspace | null;
	onClose: () => void;
}) {
	const rename = useWorkspacesStore((s) => s.rename);
	const updateConfig = useWorkspacesStore((s) => s.updateConfig);

	const [name, setName] = useState("");
	const [rootFolder, setRootFolder] = useState<string | null>(null);
	const [fileFilters, setFileFilters] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (workspace) {
			setName(workspace.name);
			setRootFolder(getWorkingFolder(workspace));
			setFileFilters(getFileFilters(workspace) ?? "");
			setSaving(false);
		}
	}, [workspace]);

	if (!workspace) return null;

	const usesWorkingFolder = workspaceTypeMeta(workspace.type).usesWorkingFolder;

	async function handleSave() {
		if (!workspace) return;
		const trimmed = name.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			if (trimmed !== workspace.name) await rename(workspace.id, trimmed);
			if (usesWorkingFolder) {
				await updateConfig(workspace.id, {
					...workspace.config,
					rootFolder: rootFolder ?? undefined,
					fileFilters: fileFilters.trim() || undefined,
				});
			}
			onClose();
		} finally {
			setSaving(false);
		}
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
			onMouseDown={onClose}
		>
			<div
				className="card bg-base-100 border border-base-300 w-full max-w-md shadow-xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="card-body gap-4">
					<h2 className="card-title text-base">Workspace settings</h2>

					<label className="form-control">
						<span className="text-xs uppercase tracking-wider text-base-content/55 font-semibold mb-1">
							Name
						</span>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							value={name}
							autoFocus
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleSave();
								if (e.key === "Escape") onClose();
							}}
						/>
					</label>

					{usesWorkingFolder && (
						<WorkingFolderFields
							rootFolder={rootFolder}
							fileFilters={fileFilters}
							onRootFolder={setRootFolder}
							onFileFilters={setFileFilters}
						/>
					)}

					<div className="flex justify-end gap-2 mt-1">
						<button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={() => void handleSave()}
							disabled={!name.trim() || saving}
						>
							Save
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Modal for creating a workspace: pick a type (base Library + enabled plugin
//! workflow types) and give it a name. Plugin workflow types only appear when
//! their plugin is enabled, so the picker stays in sync with the Plugins page.

import { useEffect, useMemo, useState } from "react";
import { WorkingFolderFields } from "@/components/WorkingFolderFields";
import { usePluginsStore } from "@/stores/pluginsStore";
import {
	creatableWorkspaceTypes,
	LIBRARY_TYPE,
	type WorkspaceTypeMeta,
} from "@/lib/workspaceTypes";

export type NewWorkspaceOptions = {
	rootFolder: string | null;
	fileFilters: string | null;
};

export function NewWorkspaceDialog({
	open,
	onClose,
	onCreate,
}: {
	open: boolean;
	onClose: () => void;
	onCreate: (
		name: string,
		type: string,
		opts: NewWorkspaceOptions,
	) => Promise<void>;
}) {
	// Re-derive the type list when plugin enable-state changes.
	usePluginsStore((s) => s.enabledIds);
	const types = creatableWorkspaceTypes();

	const [name, setName] = useState("");
	const [type, setType] = useState<string>(LIBRARY_TYPE);
	const [rootFolder, setRootFolder] = useState<string | null>(null);
	const [fileFilters, setFileFilters] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const usesWorkingFolder = useMemo(
		() => types.find((t) => t.type === type)?.usesWorkingFolder ?? false,
		[types, type],
	);

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (open) {
			setName("");
			setType(LIBRARY_TYPE);
			setRootFolder(null);
			setFileFilters("");
			setSubmitting(false);
		}
	}, [open]);

	if (!open) return null;

	async function handleCreate() {
		const trimmed = name.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		try {
			await onCreate(trimmed, type, {
				rootFolder: usesWorkingFolder ? rootFolder : null,
				fileFilters: usesWorkingFolder ? fileFilters.trim() || null : null,
			});
			onClose();
		} finally {
			setSubmitting(false);
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
					<h2 className="card-title text-base">New workspace</h2>

					<label className="form-control">
						<span className="text-xs uppercase tracking-wider text-base-content/55 font-semibold mb-1">
							Name
						</span>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							placeholder="My workspace"
							value={name}
							autoFocus
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleCreate();
								if (e.key === "Escape") onClose();
							}}
						/>
					</label>

					<div>
						<span className="text-xs uppercase tracking-wider text-base-content/55 font-semibold">
							Type
						</span>
						<div className="flex flex-col gap-2 mt-2">
							{types.map((t) => (
								<TypeOption
									key={t.type}
									meta={t}
									selected={type === t.type}
									onSelect={() => {
										setType(t.type);
										// Pre-fill filters with the type's default (e.g.
										// audio extensions for Music Library); the user
										// can still edit or clear them.
										setFileFilters(t.defaultFileFilters ?? "");
									}}
								/>
							))}
						</div>
					</div>

					{usesWorkingFolder && (
						<>
							<WorkingFolderFields
								rootFolder={rootFolder}
								fileFilters={fileFilters}
								onRootFolder={setRootFolder}
								onFileFilters={setFileFilters}
							/>
							<p className="text-[11px] text-base-content/45 -mt-1">
								Optional. You can change these later from the workspace's
								right-click menu → Settings.
							</p>
						</>
					)}

					<div className="flex justify-end gap-2 mt-1">
						<button
							type="button"
							className="btn btn-sm btn-ghost"
							onClick={onClose}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={() => void handleCreate()}
							disabled={!name.trim() || submitting}
						>
							Create
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function TypeOption({
	meta,
	selected,
	onSelect,
}: {
	meta: WorkspaceTypeMeta;
	selected: boolean;
	onSelect: () => void;
}) {
	const Icon = meta.icon;
	return (
		<label
			className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
				selected
					? "border-primary bg-primary/5"
					: "border-base-300 hover:bg-base-200"
			}`}
		>
			<input
				type="radio"
				name="workspace-type"
				className="radio radio-sm radio-primary mt-0.5"
				checked={selected}
				onChange={onSelect}
			/>
			<Icon className="size-5 shrink-0 mt-0.5 text-base-content/70" />
			<div className="min-w-0">
				<div className="font-medium text-sm">{meta.label}</div>
				{meta.description && (
					<div className="text-xs text-base-content/60">{meta.description}</div>
				)}
			</div>
		</label>
	);
}

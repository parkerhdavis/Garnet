// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reusable editor for a workspace's general working-folder + file-filters
//! config. Shared by the New Workspace dialog and the Workspace Settings
//! dialog. A workflow draws its file-tool inputs from the working folder and
//! scopes the browser to the filter extensions.

import { open } from "@tauri-apps/plugin-dialog";
import { HiFolderOpen, HiXMark } from "react-icons/hi2";

export function WorkingFolderFields({
	rootFolder,
	fileFilters,
	onRootFolder,
	onFileFilters,
}: {
	rootFolder: string | null;
	fileFilters: string;
	onRootFolder: (v: string | null) => void;
	onFileFilters: (v: string) => void;
}) {
	async function pickFolder() {
		const picked = await open({
			directory: true,
			defaultPath: rootFolder ?? undefined,
		});
		if (typeof picked === "string") onRootFolder(picked);
	}

	return (
		<>
			<div>
				<span className="text-xs uppercase tracking-wider text-base-content/55 font-semibold mb-1 block">
					Working folder
				</span>
				<div className="flex gap-1 items-center">
					<input
						type="text"
						readOnly
						value={rootFolder ?? ""}
						placeholder="No folder chosen"
						className="input input-bordered input-sm flex-1 font-mono text-xs"
						title={rootFolder ?? ""}
					/>
					{rootFolder && (
						<button
							type="button"
							className="btn btn-sm btn-ghost px-1.5"
							onClick={() => onRootFolder(null)}
							title="Clear"
						>
							<HiXMark className="size-4" />
						</button>
					)}
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => void pickFolder()}
					>
						<HiFolderOpen className="size-4" />
						Choose…
					</button>
				</div>
			</div>

			<label className="form-control">
				<span className="text-xs uppercase tracking-wider text-base-content/55 font-semibold mb-1">
					File filters
				</span>
				<input
					type="text"
					className="input input-bordered input-sm w-full font-mono text-xs"
					placeholder="e.g. png tga exr, or mp3 flac (blank = all types)"
					value={fileFilters}
					onChange={(e) => onFileFilters(e.target.value)}
				/>
			</label>
		</>
	);
}

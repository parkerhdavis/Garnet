// SPDX-License-Identifier: AGPL-3.0-or-later
//! Compact file picker with thumbnail preview, used to assign source textures
//! in the Pack / Normal tools. Ported from Packi, minus its settings-store
//! default-directory dependency (not yet ported to Garnet).

import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HiArrowUpTray, HiXMark } from "react-icons/hi2";
import { useTexturingWorkspace } from "@/plugins/texturing/workspaceContext";

interface DropZoneProps {
	label: string;
	filePath: string | null;
	thumbnail: string | null;
	onFilePicked: (path: string) => void;
	onClear: () => void;
	accept?: string[];
	compact?: boolean;
	loading?: boolean;
}

const DEFAULT_EXTS = ["png", "tga", "jpg", "jpeg", "exr", "tif", "tiff", "bmp"];

export default function DropZone({
	label,
	filePath,
	thumbnail,
	onFilePicked,
	onClear,
	accept,
	compact = false,
	loading = false,
}: DropZoneProps) {
	const [dragOver, setDragOver] = useState(false);
	// Pre-target the picker to the workspace's working folder when present.
	const workingFolder = useTexturingWorkspace()?.rootFolder ?? undefined;

	const handleBrowse = useCallback(async () => {
		const result = await open({
			multiple: false,
			defaultPath: workingFolder,
			filters: [{ name: "Images", extensions: accept ?? DEFAULT_EXTS }],
		});
		if (typeof result === "string") onFilePicked(result);
	}, [accept, onFilePicked, workingFolder]);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
		setDragOver(true);
	}, []);

	const handleDragLeave = useCallback(() => setDragOver(false), []);

	// Accept an in-app drag carrying an absolute file path (e.g. a future
	// "drag an asset here" affordance from the library).
	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragOver(false);
			const path = e.dataTransfer.getData("application/garnet-filepath");
			if (path) onFilePicked(path);
		},
		[onFilePicked],
	);

	const filename = filePath?.split(/[\\/]/).pop() ?? null;

	if (loading) {
		return (
			<div
				className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 w-full ${
					compact ? "p-2" : "p-4"
				}`}
			>
				<span
					className={`text-base-content/40 ${compact ? "text-xs" : "text-sm"}`}
				>
					Importing…
				</span>
				<progress className="progress progress-primary w-full" />
			</div>
		);
	}

	if (filePath && thumbnail) {
		return (
			<div
				className={`flex items-center gap-2 rounded-lg bg-base-200 border border-base-300 ${
					compact ? "p-1.5" : "p-2"
				} ${dragOver ? "border-primary bg-primary/10" : ""}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<img
					src={
						thumbnail.startsWith("data:")
							? thumbnail
							: `data:image/png;base64,${thumbnail}`
					}
					alt={filename ?? ""}
					className={`rounded object-cover bg-base-300 ${compact ? "size-8" : "size-12"}`}
				/>
				<div className="flex-1 min-w-0">
					<p className="text-xs font-medium truncate" title={filename ?? ""}>
						{filename}
					</p>
					<p className="text-xs text-base-content/40">{label}</p>
				</div>
				<button
					type="button"
					onClick={onClear}
					className="btn btn-ghost btn-xs px-1"
					title="Remove"
				>
					<HiXMark className="size-3.5" />
				</button>
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={handleBrowse}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed transition-colors cursor-pointer w-full ${
				dragOver
					? "border-primary bg-primary/10"
					: "border-base-300 hover:border-base-content/30 hover:bg-base-200/50"
			} ${compact ? "p-2" : "p-4"}`}
		>
			<HiArrowUpTray className={compact ? "size-3.5" : "size-5"} />
			<span
				className={`text-base-content/40 ${compact ? "text-xs" : "text-sm"}`}
			>
				{label}
			</span>
		</button>
	);
}

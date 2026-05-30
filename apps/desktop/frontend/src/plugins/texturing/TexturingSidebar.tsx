// SPDX-License-Identifier: AGPL-3.0-or-later
//! The 3D Texturing workflow's left sidebar, modeled directly on Packi's
//! layout: a vertical MODULES list on top, then an INPUT file browser (the
//! workspace's working folder, scoped by its file filters), then an OUTPUT
//! default-export-directory panel at the bottom. Module naming/ordering is
//! Garnet's. Input rows drag into any tool's drop zone (they accept the
//! `application/garnet-filepath` MIME); both working dirs persist on the
//! workspace.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { IconType } from "react-icons";
import {
	HiAdjustmentsHorizontal,
	HiArrowUpTray,
	HiCalculator,
	HiCube,
	HiFolderOpen,
	HiFolderPlus,
	HiPhoto,
	HiSwatch,
	HiXMark,
} from "react-icons/hi2";
import { parseFileFilters } from "@/lib/workspaceConfig";
import { useTexturingWorkspace } from "@/plugins/texturing/workspaceContext";

export type TexturingModuleId = "pack" | "adjust" | "size" | "preview";

const MODULES: { id: TexturingModuleId; label: string; icon: IconType }[] = [
	{ id: "pack", label: "Un/Pack", icon: HiSwatch },
	{ id: "adjust", label: "Adjust", icon: HiAdjustmentsHorizontal },
	{ id: "size", label: "Size", icon: HiCalculator },
	{ id: "preview", label: "Preview", icon: HiCube },
];

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export function TexturingSidebar({
	module,
	onModule,
	workspaceName,
}: {
	module: TexturingModuleId;
	onModule: (id: TexturingModuleId) => void;
	workspaceName: string;
}) {
	const ws = useTexturingWorkspace();
	const [files, setFiles] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [selectedPreview, setSelectedPreview] = useState<string | null>(null);

	const rootFolder = ws?.rootFolder ?? null;
	const fileFilters = ws?.fileFilters ?? null;
	const outputDir = ws?.outputDir ?? null;

	useEffect(() => {
		if (!rootFolder) {
			setFiles([]);
			return;
		}
		let cancelled = false;
		setLoading(true);
		void invoke<string[]>("list_image_files", { dir: rootFolder, recursive: false })
			.then((all) => {
				if (cancelled) return;
				const exts = parseFileFilters(fileFilters);
				setFiles(
					exts
						? all.filter((p) => exts.includes((p.split(".").pop() ?? "").toLowerCase()))
						: all,
				);
			})
			.catch((e) => {
				if (!cancelled) console.error("Failed to list working folder:", e);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [rootFolder, fileFilters]);

	const selectFile = useCallback(async (path: string) => {
		setSelected(path);
		setSelectedPreview(null);
		try {
			const b64 = await invoke<string>("load_image_as_base64", { path, maxPreviewSize: 256 });
			setSelectedPreview(b64);
		} catch (e) {
			console.error("Failed to preview file:", e);
		}
	}, []);

	async function chooseInputFolder() {
		const picked = await open({ directory: true, defaultPath: rootFolder ?? undefined });
		if (typeof picked === "string") ws?.setRootFolder(picked);
	}

	async function chooseOutputFolder() {
		const picked = await open({ directory: true, defaultPath: outputDir ?? undefined });
		if (typeof picked === "string") ws?.setOutputDir(picked);
	}

	return (
		<div className="w-56 shrink-0 flex flex-col border-r border-base-300 bg-base-200/30 min-h-0">
			{/* Branding */}
			<div className="px-3 py-2.5 border-b border-base-300 flex items-center gap-2 shrink-0">
				<HiCube className="size-4 text-base-content/60 shrink-0" />
				<div className="min-w-0">
					<div className="text-sm font-semibold truncate leading-tight">{workspaceName}</div>
					<div className="text-[10px] text-base-content/50">3D Texturing</div>
				</div>
			</div>

			{/* Modules */}
			<div className="px-2 pt-3 pb-2 shrink-0">
				<div className="text-[10px] uppercase tracking-wider text-base-content/40 px-1.5 mb-1 font-semibold">
					Modules
				</div>
				<ul className="flex flex-col gap-0.5">
					{MODULES.map((m) => {
						const Icon = m.icon;
						const active = module === m.id;
						return (
							<li key={m.id}>
								<button
									type="button"
									onClick={() => onModule(m.id)}
									className={`flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded text-left transition-colors ${
										active
											? "bg-primary/15 text-primary font-medium"
											: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
									}`}
								>
									<Icon className="size-4 shrink-0" />
									<span className="text-sm">{m.label}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			{/* Input */}
			<div className="flex-1 min-h-0 flex flex-col border-t border-base-300">
				<div className="flex items-center gap-1 px-2 py-1.5 shrink-0">
					<span className="text-[10px] font-semibold text-base-content/40 uppercase tracking-wider flex-1">
						Input
					</span>
					{rootFolder && (
						<button
							type="button"
							onClick={() => ws?.setRootFolder(null)}
							className="btn btn-ghost btn-xs px-1"
							title="Clear working folder"
						>
							<HiXMark className="size-3.5" />
						</button>
					)}
					<button
						type="button"
						onClick={() => void chooseInputFolder()}
						className="btn btn-ghost btn-xs px-1"
						title="Set working input folder"
					>
						<HiFolderPlus className="size-4" />
					</button>
				</div>

				{rootFolder ? (
					<>
						<div
							className="px-2 pb-1 text-[11px] text-base-content/45 truncate shrink-0"
							title={rootFolder}
						>
							{basename(rootFolder)}
						</div>
						<div className="flex-1 overflow-y-auto min-h-0">
							{loading ? (
								<div className="p-3 text-xs text-base-content/40">Loading…</div>
							) : files.length === 0 ? (
								<div className="p-3 text-xs text-base-content/40">
									No matching images in this folder.
								</div>
							) : (
								files.map((path) => (
									<button
										key={path}
										type="button"
										draggable
										onDragStart={(e) => {
											e.dataTransfer.setData("application/garnet-filepath", path);
											e.dataTransfer.effectAllowed = "copy";
										}}
										onClick={() => void selectFile(path)}
										className={`flex items-center gap-1.5 w-full px-2 py-1 text-left cursor-grab active:cursor-grabbing hover:bg-base-300/50 ${
											selected === path ? "bg-primary/10 text-primary" : ""
										}`}
										title={path}
									>
										<HiPhoto className="size-3 shrink-0 opacity-50" />
										<span className="text-xs truncate">{basename(path)}</span>
									</button>
								))
							)}
						</div>
						{selectedPreview && (
							<div className="border-t border-base-300 p-2 shrink-0">
								<img
									src={`data:image/png;base64,${selectedPreview}`}
									alt={selected ? basename(selected) : ""}
									className="w-full aspect-square object-contain rounded bg-base-300"
								/>
							</div>
						)}
					</>
				) : (
					<button
						type="button"
						onClick={() => void chooseInputFolder()}
						className="flex flex-col items-center justify-center gap-2 flex-1 text-base-content/30 hover:text-base-content/50 p-4 text-xs"
					>
						<HiArrowUpTray className="size-5" />
						Choose a working folder
					</button>
				)}
			</div>

			{/* Output */}
			<div className="border-t border-base-300 shrink-0">
				<div className="px-2 py-1.5">
					<span className="text-[10px] font-semibold text-base-content/40 uppercase tracking-wider">
						Output
					</span>
				</div>
				{outputDir ? (
					<button
						type="button"
						onClick={() => void chooseOutputFolder()}
						className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-base-300/50"
						title={`Default export location: ${outputDir}`}
					>
						<HiFolderOpen className="size-3.5 shrink-0 text-base-content/50" />
						<span className="text-xs truncate">{basename(outputDir)}</span>
					</button>
				) : (
					<button
						type="button"
						onClick={() => void chooseOutputFolder()}
						className="flex items-center gap-1.5 w-full px-2 pb-2 text-xs text-base-content/45 hover:text-base-content/70"
					>
						<HiFolderOpen className="size-3.5" />
						Set export folder
					</button>
				)}
			</div>
		</div>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! The 3D Texturing workflow's left sidebar, modeled on Packi's layout: a
//! vertical MODULES list, an INPUT file browser (the workspace's working
//! folder, scoped by its file filters), and an OUTPUT default-export panel.
//! The three sections split the available height into equal thirds. Module
//! naming/ordering is Garnet's. Input rows drag into any tool's drop zone
//! (they accept the `application/garnet-filepath` MIME); both working dirs
//! persist on the workspace.

import { useEffect, useState } from "react";
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

const HEADING =
	"text-xs uppercase tracking-wider text-base-content/45 font-semibold";

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
		void invoke<string[]>("list_image_files", {
			dir: rootFolder,
			recursive: false,
		})
			.then((all) => {
				if (cancelled) return;
				const exts = parseFileFilters(fileFilters);
				setFiles(
					exts
						? all.filter((p) =>
								exts.includes((p.split(".").pop() ?? "").toLowerCase()),
							)
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

	async function chooseInputFolder() {
		const picked = await open({
			directory: true,
			defaultPath: rootFolder ?? undefined,
		});
		if (typeof picked === "string") ws?.setRootFolder(picked);
	}

	async function chooseOutputFolder() {
		const picked = await open({
			directory: true,
			defaultPath: outputDir ?? undefined,
		});
		if (typeof picked === "string") ws?.setOutputDir(picked);
	}

	return (
		<div className="w-56 shrink-0 flex flex-col border-r border-base-300 bg-base-200/30 min-h-0">
			{/* Branding */}
			<div className="px-3 py-2.5 border-b border-base-300 flex items-center gap-2 shrink-0">
				<HiCube className="size-4 text-base-content/60 shrink-0" />
				<div className="min-w-0">
					<div className="text-sm font-semibold truncate leading-tight">
						{workspaceName}
					</div>
					<div className="text-[10px] text-base-content/50">3D Texturing</div>
				</div>
			</div>

			{/* Modules — equal third */}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden px-2 pt-3 pb-2">
				<div className={`${HEADING} px-1.5 mb-2`}>Modules</div>
				<ul className="flex flex-col gap-0.5 overflow-y-auto">
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

			{/* Input — equal third */}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden border-t border-base-300 pt-2.5">
				<div className="flex items-center gap-1 px-3 mb-1.5 shrink-0">
					<span className={`${HEADING} flex-1`}>Input</span>
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
							className="px-3 pb-1 text-[11px] text-base-content/45 truncate shrink-0"
							title={rootFolder}
						>
							{basename(rootFolder)}
						</div>
						<div className="flex-1 overflow-y-auto min-h-0 px-1">
							{loading ? (
								<div className="px-2 py-1 text-xs text-base-content/40">
									Loading…
								</div>
							) : files.length === 0 ? (
								<div className="px-2 py-1 text-xs text-base-content/40">
									No matching images.
								</div>
							) : (
								files.map((path) => (
									<button
										key={path}
										type="button"
										draggable
										onDragStart={(e) => {
											e.dataTransfer.setData(
												"application/garnet-filepath",
												path,
											);
											e.dataTransfer.effectAllowed = "copy";
										}}
										onClick={() => setSelected(path)}
										className={`flex items-center gap-1.5 w-full px-2 py-1 rounded text-left cursor-grab active:cursor-grabbing hover:bg-base-300/50 ${
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

			{/* Output — equal third */}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden border-t border-base-300 pt-2.5 px-3">
				<div className={`${HEADING} mb-1.5 shrink-0`}>Output</div>
				<p className="text-[11px] text-base-content/45 mb-2.5 leading-snug">
					Set a working output directory. Used as the default export location.
				</p>
				{outputDir ? (
					<button
						type="button"
						onClick={() => void chooseOutputFolder()}
						className="flex items-center gap-2 px-2 py-1.5 -mx-1 rounded text-left hover:bg-base-300/50"
						title={outputDir}
					>
						<HiFolderOpen className="size-4 shrink-0 text-base-content/50" />
						<span className="text-xs truncate">{basename(outputDir)}</span>
					</button>
				) : (
					<button
						type="button"
						onClick={() => void chooseOutputFolder()}
						className="btn btn-sm btn-ghost justify-start gap-2 px-2 self-start"
					>
						<HiFolderOpen className="size-4" />
						Select Folder
					</button>
				)}
			</div>
		</div>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! The 3D Texturing workflow — the interior rendered for a "texturing"-type
//! workspace. A centered tab bar switches between the plugin's tools; a shared
//! Input/Output rail (the working folder browser + default export dir) sits to
//! the left of every tab. The workspace context provides the working dirs to
//! the shared DropZone/ExportPanel.

import { useState } from "react";
import type { IconType } from "react-icons";
import {
	HiCube,
	HiSwatch,
	HiAdjustmentsHorizontal,
	HiCalculator,
} from "react-icons/hi2";
import type { Workspace } from "@/lib/tauri";
import { TexturingWorkspaceProvider } from "@/plugins/texturing/workspaceContext";
import { WorkingFilesRail } from "@/plugins/texturing/WorkingFilesRail";
import PackTools from "@/plugins/texturing/tools/PackTools";
import SizeTools from "@/plugins/texturing/tools/SizeTools";
import NormalMapTools from "@/plugins/texturing/tools/NormalMapTools";
import PreviewTools from "@/plugins/texturing/tools/PreviewTools";

type TabId = "pack" | "adjust" | "size" | "preview";

const TABS: { id: TabId; label: string; icon: IconType }[] = [
	{ id: "pack", label: "Un/Pack", icon: HiSwatch },
	{ id: "adjust", label: "Adjust", icon: HiAdjustmentsHorizontal },
	{ id: "size", label: "Size", icon: HiCalculator },
	{ id: "preview", label: "Preview", icon: HiCube },
];

export function TexturingWorkflow({ workspace }: { workspace: Workspace }) {
	const [tab, setTab] = useState<TabId>("pack");

	return (
		<TexturingWorkspaceProvider workspace={workspace}>
			<div className="flex-1 min-h-0 flex flex-col">
				<header className="px-3 py-2 border-b border-base-300 bg-base-100 flex items-center gap-3 shrink-0">
					<div className="flex-1 min-w-0 flex items-center gap-2">
						<HiCube className="size-4 text-base-content/60 shrink-0" />
						<span className="text-sm font-semibold truncate">{workspace.name}</span>
						<span className="badge badge-ghost badge-sm shrink-0">3D Texturing</span>
					</div>

					<div className="tabs tabs-boxed bg-base-200 p-1 shrink-0">
						{TABS.map((t) => {
							const Icon = t.icon;
							return (
								<button
									key={t.id}
									type="button"
									className={`tab gap-2 px-4 text-sm font-medium ${
										tab === t.id ? "tab-active" : ""
									}`}
									onClick={() => setTab(t.id)}
								>
									<Icon className="size-4" />
									{t.label}
								</button>
							);
						})}
					</div>

					{/* Right spacer balances the left name column so the tabs stay
					    visually centered. */}
					<div className="flex-1" />
				</header>

				<div className="flex-1 min-h-0 flex">
					<WorkingFilesRail />
					<div className="flex-1 min-h-0">
						{tab === "pack" && <PackTools />}
						{tab === "adjust" && <NormalMapTools />}
						{tab === "size" && <SizeTools />}
						{tab === "preview" && <PreviewTools />}
					</div>
				</div>
			</div>
		</TexturingWorkspaceProvider>
	);
}

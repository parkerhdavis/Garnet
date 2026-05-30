// SPDX-License-Identifier: AGPL-3.0-or-later
//! The 3D Texturing workflow — the interior rendered for a "texturing"-type
//! workspace. A tab bar switches between the plugin's tools: Pack (channel
//! pack/unpack/swizzle), Adjust (normal-map ops), Size (texture info / VRAM /
//! mip chain), and Preview (2D tiling + 3D PBR — lands in the next commit).

import { useState } from "react";
import type { IconType } from "react-icons";
import {
	HiCube,
	HiSwatch,
	HiAdjustmentsHorizontal,
	HiCalculator,
} from "react-icons/hi2";
import type { Workspace } from "@/lib/tauri";
import PackTools from "@/plugins/texturing/tools/PackTools";
import SizeTools from "@/plugins/texturing/tools/SizeTools";
import NormalMapTools from "@/plugins/texturing/tools/NormalMapTools";

type TabId = "pack" | "adjust" | "size" | "preview";

const TABS: { id: TabId; label: string; icon: IconType }[] = [
	{ id: "pack", label: "Pack", icon: HiSwatch },
	{ id: "adjust", label: "Adjust", icon: HiAdjustmentsHorizontal },
	{ id: "size", label: "Size", icon: HiCalculator },
	{ id: "preview", label: "Preview", icon: HiCube },
];

export function TexturingWorkflow({ workspace }: { workspace: Workspace }) {
	const [tab, setTab] = useState<TabId>("pack");

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<header className="px-3 py-2 border-b border-base-300 bg-base-100 flex items-center gap-3 shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<HiCube className="size-4 text-base-content/60 shrink-0" />
					<span className="text-sm font-semibold truncate">{workspace.name}</span>
					<span className="badge badge-ghost badge-sm">3D Texturing</span>
				</div>
				<div className="flex-1" />
				<div className="tabs tabs-boxed tabs-sm bg-base-200">
					{TABS.map((t) => {
						const Icon = t.icon;
						return (
							<button
								key={t.id}
								type="button"
								className={`tab gap-1.5 ${tab === t.id ? "tab-active" : ""}`}
								onClick={() => setTab(t.id)}
							>
								<Icon className="size-3.5" />
								{t.label}
							</button>
						);
					})}
				</div>
			</header>

			<div className="flex-1 min-h-0">
				{tab === "pack" && <PackTools />}
				{tab === "adjust" && <NormalMapTools />}
				{tab === "size" && <SizeTools />}
				{tab === "preview" && <PreviewPlaceholder />}
			</div>
		</div>
	);
}

function PreviewPlaceholder() {
	return (
		<div className="flex flex-col items-center justify-center h-full text-center p-12 text-base-content/40">
			<HiCube className="size-10 mb-3 opacity-50" />
			<p className="text-sm">2D tiling + 3D PBR material preview lands in the next commit.</p>
		</div>
	);
}

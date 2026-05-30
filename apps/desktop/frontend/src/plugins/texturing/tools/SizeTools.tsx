// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSizeStore } from "@/plugins/texturing/stores/sizeStore";
import type { SizeSubmodule } from "@/plugins/texturing/stores/sizeStore";
import DropZone from "@/plugins/texturing/ui/DropZone";
import TextureInfoPanel from "@/plugins/texturing/size/TextureInfoPanel";
import VramBudgetPanel from "@/plugins/texturing/size/VramBudgetPanel";
import MipChainPanel from "@/plugins/texturing/size/MipChainPanel";
import { LuFileSearch, LuHardDrive, LuLayers } from "react-icons/lu";

const submodules: { id: SizeSubmodule; label: string; description: string; icon: React.ReactNode }[] = [
	{ id: "info", label: "Texture Info", description: "View resolution, channels, bit depth, and file size.", icon: <LuFileSearch size={15} /> },
	{ id: "vram", label: "VRAM Budget", description: "Estimate GPU memory cost across compression formats.", icon: <LuHardDrive size={15} /> },
	{ id: "mipchain", label: "Mip Chain", description: "Visualize all mip levels with dimensions and sizes.", icon: <LuLayers size={15} /> },
];

export default function SizeTools() {
	const activeSubmodule = useSizeStore((s) => s.activeSubmodule);
	const setSubmodule = useSizeStore((s) => s.setSubmodule);
	const inputPath = useSizeStore((s) => s.inputPath);
	const inputPreview = useSizeStore((s) => s.inputPreview);
	const inputLoading = useSizeStore((s) => s.inputLoading);
	const loadInput = useSizeStore((s) => s.loadInput);
	const clearInput = useSizeStore((s) => s.clearInput);

	return (
		<div className="flex h-full min-h-0">
			{/* Left sidebar */}
			<div className="w-64 shrink-0 flex flex-col border-r border-base-300 bg-base-200/30">
				{/* Input */}
				<div className="p-3 border-b border-base-300 shrink-0">
					<label className="text-xs font-semibold text-base-content/50 mb-1 block">
						Input Image
					</label>
					<DropZone
						label="Drop image"
						filePath={inputPath}
						thumbnail={inputPreview}
						onFilePicked={loadInput}
						onClear={clearInput}
						loading={inputLoading}
						compact
					/>
				</div>

				{/* Submodule nav */}
				<div className="px-3 pt-3 pb-1">
					<div className="text-xs font-semibold text-base-content/50 uppercase tracking-wider">
						Analysis
					</div>
				</div>
				<div className="flex flex-col gap-0.5 px-1.5 pb-2">
					{submodules.map((sub) => (
						<button
							key={sub.id}
							type="button"
							onClick={() => setSubmodule(sub.id)}
							className={`flex flex-col gap-0.5 px-2.5 py-2 rounded text-left cursor-pointer transition-colors ${
								activeSubmodule === sub.id
									? "text-primary bg-primary/10 font-medium"
									: "text-base-content/60 hover:text-base-content hover:bg-base-300/50"
							}`}
						>
							<div className="flex items-center gap-2.5">
								<span className="shrink-0 opacity-70">{sub.icon}</span>
								<span className="text-sm">{sub.label}</span>
							</div>
							<span className="text-xs text-base-content/30 leading-snug pl-[1.625rem]">
								{sub.description}
							</span>
						</button>
					))}
				</div>
			</div>

			{/* Content area */}
			<div className="flex-1 min-w-0 flex">
				{activeSubmodule === "info" && <TextureInfoPanel />}
				{activeSubmodule === "vram" && <VramBudgetPanel />}
				{activeSubmodule === "mipchain" && <MipChainPanel />}
			</div>
		</div>
	);
}

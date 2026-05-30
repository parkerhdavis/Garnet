// SPDX-License-Identifier: AGPL-3.0-or-later
//! The texturing "Adjust" tool: normal-map operations (flip-green,
//! height-to-normal, blend, normalize) with a before/after preview and export.
//! General color adjustments live in Garnet's base image editor.

import DropZone from "@/plugins/texturing/ui/DropZone";
import SliderWithInput from "@/plugins/texturing/ui/SliderWithInput";
import ComparisonView from "@/plugins/texturing/ui/ComparisonView";
import ExportPanel from "@/plugins/texturing/ui/ExportPanel";
import type { ExportFormat } from "@/plugins/texturing/types";
import {
	type NormalOperation,
	useNormalStore,
} from "@/plugins/texturing/stores/normalStore";

const OPERATIONS: { id: NormalOperation; label: string; hint: string }[] = [
	{
		id: "flip",
		label: "Flip Green",
		hint: "Swap DirectX ↔ OpenGL convention.",
	},
	{
		id: "height-to-normal",
		label: "Height → Normal",
		hint: "Sobel from a grayscale heightmap.",
	},
	{ id: "blend", label: "Blend", hint: "Reoriented normal-map blend (RNM)." },
	{
		id: "normalize",
		label: "Normalize",
		hint: "Re-normalize vectors to unit length.",
	},
];

const EXPORT_FORMATS: ExportFormat[] = ["png8", "png16", "tga"];

export default function NormalMapTools() {
	const {
		inputPath,
		inputInfo,
		inputPreview,
		inputLoading,
		operation,
		strength,
		blendFactor,
		secondPath,
		secondPreview,
		resultPreview,
		previewing,
		loadInput,
		clearInput,
		loadSecond,
		clearSecond,
		setOperation,
		setStrength,
		setBlendFactor,
		exportResult,
	} = useNormalStore();

	return (
		<div className="flex h-full min-h-0">
			{/* Controls */}
			<div className="w-64 shrink-0 flex flex-col border-r border-base-300 overflow-y-auto">
				<div className="p-3 space-y-3">
					<div>
						<span className="text-xs font-semibold text-base-content/50 mb-1 block">
							Input
						</span>
						<DropZone
							label="Normal map / heightmap"
							filePath={inputPath}
							thumbnail={inputPreview}
							onFilePicked={loadInput}
							onClear={clearInput}
							loading={inputLoading}
						/>
					</div>

					<div>
						<span className="text-xs font-semibold text-base-content/50 mb-1 block">
							Operation
						</span>
						<div className="flex flex-col gap-1">
							{OPERATIONS.map((op) => (
								<button
									key={op.id}
									type="button"
									onClick={() => setOperation(op.id)}
									className={`text-left rounded px-2 py-1.5 border transition-colors ${
										operation === op.id
											? "border-primary bg-primary/10"
											: "border-base-300 hover:bg-base-200"
									}`}
								>
									<div className="text-xs font-medium">{op.label}</div>
									<div className="text-[10px] text-base-content/50">
										{op.hint}
									</div>
								</button>
							))}
						</div>
					</div>

					{operation === "height-to-normal" && (
						<SliderWithInput
							label="Strength"
							value={strength}
							onChange={setStrength}
							min={0.1}
							max={10}
							step={0.1}
							decimals={1}
						/>
					)}

					{operation === "blend" && (
						<div className="space-y-2">
							<div>
								<span className="text-xs font-semibold text-base-content/50 mb-1 block">
									Detail normal
								</span>
								<DropZone
									label="Second normal map"
									filePath={secondPath}
									thumbnail={secondPreview}
									onFilePicked={loadSecond}
									onClear={clearSecond}
									compact
								/>
							</div>
							<SliderWithInput
								label="Blend factor"
								value={blendFactor}
								onChange={setBlendFactor}
								min={0}
								max={1}
								step={0.01}
								decimals={2}
								rangeLabels={["Base", "Detail"]}
							/>
						</div>
					)}

					<ExportPanel
						formats={EXPORT_FORMATS}
						defaultFormat="png8"
						onExport={exportResult}
						disabled={!inputPath || (operation === "blend" && !secondPath)}
						filenameDefault="normal"
					/>
				</div>
			</div>

			{/* Preview */}
			<div className="flex-1 min-w-0 relative">
				{inputPreview ? (
					<ComparisonView
						beforeImage={inputPreview}
						afterImage={resultPreview}
						beforeInfo={inputInfo}
						afterInfo={inputInfo}
						beforeLabel="Original"
						afterLabel="Result"
					/>
				) : (
					<div className="flex items-center justify-center h-full text-base-content/30 text-sm">
						Load a texture to begin.
					</div>
				)}
				{previewing && (
					<div className="absolute top-2 right-2 text-[10px] uppercase tracking-wider text-base-content/55 bg-base-100/80 px-2 py-0.5 rounded">
						Rendering…
					</div>
				)}
			</div>
		</div>
	);
}

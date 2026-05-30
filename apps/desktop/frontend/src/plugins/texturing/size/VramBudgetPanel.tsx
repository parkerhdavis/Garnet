// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useMemo, useEffect } from "react";
import { useSizeStore } from "@/plugins/texturing/stores/sizeStore";
import TexturePreview from "@/plugins/texturing/ui/TexturePreview";
import {
	GPU_FORMATS,
	computeTotalWithMips,
	formatBytes,
} from "@/plugins/texturing/size/vramFormats";

/** Standard power-of-two resolutions from 16384 down to 32 */
const STANDARD_RESOLUTIONS = [
	16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32,
];

export default function VramBudgetPanel() {
	const info = useSizeStore((s) => s.inputInfo);
	const preview = useSizeStore((s) => s.inputPreview);
	const [includeMips, setIncludeMips] = useState(true);
	// Build resolution steps: ascending order (32 → 16384), with actual inserted in sorted position
	const { resolutionSteps, defaultIndex } = useMemo(() => {
		if (!info)
			return {
				resolutionSteps: [] as {
					label: string;
					width: number;
					height: number;
					isActual: boolean;
				}[],
				defaultIndex: 0,
			};
		const ascending = [...STANDARD_RESOLUTIONS].reverse(); // 32, 64, ..., 16384
		const steps: {
			label: string;
			width: number;
			height: number;
			isActual: boolean;
		}[] = [];
		const actualSize = Math.max(info.width, info.height);
		let inserted = false;
		let actualIndex = 0;
		for (const size of ascending) {
			if (!inserted && actualSize <= size) {
				if (actualSize === size && info.width === info.height) {
					// Actual matches this standard size exactly — mark it
					steps.push({
						label: `${size}×${size} (actual)`,
						width: info.width,
						height: info.height,
						isActual: true,
					});
					actualIndex = steps.length - 1;
					inserted = true;
					continue;
				}
				// Insert actual before this larger standard size
				steps.push({
					label: `${info.width}×${info.height} (actual)`,
					width: info.width,
					height: info.height,
					isActual: true,
				});
				actualIndex = steps.length - 1;
				inserted = true;
			}
			steps.push({
				label: `${size}×${size}`,
				width: size,
				height: size,
				isActual: false,
			});
		}
		if (!inserted) {
			// Actual is larger than all standard sizes
			steps.push({
				label: `${info.width}×${info.height} (actual)`,
				width: info.width,
				height: info.height,
				isActual: true,
			});
			actualIndex = steps.length - 1;
		}
		return { resolutionSteps: steps, defaultIndex: actualIndex };
	}, [info]);

	const [selectedIndex, setSelectedIndex] = useState(defaultIndex);

	// Reset slider to actual resolution when image changes
	useEffect(() => {
		setSelectedIndex(defaultIndex);
	}, [defaultIndex]);

	if (!info) {
		return (
			<div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
				Load an image to estimate VRAM usage.
			</div>
		);
	}

	const clampedIndex = Math.min(selectedIndex, resolutionSteps.length - 1);
	const activeRes = resolutionSteps[clampedIndex] ?? resolutionSteps[0];
	const { width, height } = activeRes;

	const estimates = GPU_FORMATS.map((fmt) => {
		const baseSize = fmt.sizeBytes(width, height);
		const totalSize = includeMips
			? computeTotalWithMips(fmt, width, height)
			: baseSize;
		return { ...fmt, baseSize, totalSize };
	});

	const maxSize = Math.max(...estimates.map((e) => e.totalSize));

	return (
		<div className="flex-1 min-w-0 flex">
			{/* VRAM table */}
			<div className="w-[26rem] shrink-0 border-r border-base-300 flex flex-col overflow-y-auto">
				<div className="p-4 pb-2 shrink-0">
					<div className="flex items-center justify-between mb-3">
						<div className="text-sm font-semibold text-base-content">
							VRAM Budget
						</div>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={includeMips}
								onChange={(e) => setIncludeMips(e.target.checked)}
								className="checkbox checkbox-xs checkbox-primary"
							/>
							<span className="text-xs text-base-content/60">
								Include mip chain
							</span>
						</label>
					</div>

					{/* Resolution slider */}
					<div className="mb-3">
						<label className="text-xs text-base-content/50 mb-1 block">
							Resolution: {activeRes.label}
						</label>
						<input
							type="range"
							min="0"
							max={resolutionSteps.length - 1}
							step="1"
							value={clampedIndex}
							onChange={(e) =>
								setSelectedIndex(Number.parseInt(e.target.value))
							}
							className="range range-primary range-xs w-full"
						/>
						<div className="flex justify-between text-xs text-base-content/30 mt-0.5">
							<span>{resolutionSteps[0]?.label.split(" ")[0]}</span>
							<span>
								{
									resolutionSteps[resolutionSteps.length - 1]?.label.split(
										" ",
									)[0]
								}
							</span>
						</div>
					</div>

					<div className="text-xs text-base-content/40 mb-3">
						Estimated GPU memory for a {width}×{height} texture
						{includeMips ? " with mip chain" : ""}.
					</div>
				</div>

				<div className="flex-1 overflow-y-auto px-4 pb-4">
					<table className="w-full">
						<thead>
							<tr className="text-xs text-base-content/40 border-b border-base-300">
								<th className="text-left py-1.5 font-medium">Format</th>
								<th className="text-right py-1.5 font-medium pr-3 w-16">BPP</th>
								<th className="text-right py-1.5 font-medium w-24">Size</th>
								<th className="py-1.5 w-24" />
							</tr>
						</thead>
						<tbody>
							{estimates.map((est) => (
								<tr
									key={est.name}
									className="border-b border-base-300/30 last:border-0"
								>
									<td className="py-1.5">
										<div className="text-xs font-medium text-base-content/80">
											{est.name}
										</div>
										<div className="text-xs text-base-content/30">
											{est.description}
										</div>
									</td>
									<td className="text-right text-xs font-mono text-base-content/50 pr-3">
										{est.bpp % 1 === 0 ? est.bpp : est.bpp.toFixed(2)}
									</td>
									<td className="text-right text-xs font-mono text-base-content/80">
										{formatBytes(est.totalSize)}
									</td>
									<td className="py-1.5 pl-2">
										<div className="h-2 bg-base-300/50 rounded-full overflow-hidden">
											<div
												className="h-full bg-primary/60 rounded-full"
												style={{ width: `${(est.totalSize / maxSize) * 100}%` }}
											/>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			{/* Preview */}
			<TexturePreview imageData={preview} imageInfo={info} className="flex-1" />
		</div>
	);
}

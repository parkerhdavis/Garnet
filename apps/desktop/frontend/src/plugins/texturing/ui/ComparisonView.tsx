// SPDX-License-Identifier: AGPL-3.0-or-later
//! Before/after comparison: synchronized split view or A/B toggle. Ported from
//! Packi.

import { useState, useCallback } from "react";
import { HiArrowsRightLeft, HiViewColumns } from "react-icons/hi2";
import TexturePreview from "@/plugins/texturing/ui/TexturePreview";
import type { ImageInfo } from "@/plugins/texturing/types";

type CompareMode = "side-by-side" | "ab-toggle";

interface ComparisonViewProps {
	beforeImage: string | null;
	afterImage: string | null;
	beforeInfo?: ImageInfo | null;
	afterInfo?: ImageInfo | null;
	beforeLabel?: string;
	afterLabel?: string;
	className?: string;
}

export default function ComparisonView({
	beforeImage,
	afterImage,
	beforeInfo,
	afterInfo,
	beforeLabel = "Before",
	afterLabel = "After",
	className = "",
}: ComparisonViewProps) {
	const [mode, setMode] = useState<CompareMode>("side-by-side");
	const [abShowAfter, setAbShowAfter] = useState(false);
	const [syncZoom, setSyncZoom] = useState(1);
	const [syncPan, setSyncPan] = useState({ x: 0, y: 0 });

	const handleViewChange = useCallback(
		(zoom: number, pan: { x: number; y: number }) => {
			setSyncZoom(zoom);
			setSyncPan(pan);
		},
		[],
	);

	const dims = beforeInfo ?? afterInfo;

	return (
		<div className={`flex flex-col h-full ${className}`}>
			<div className="flex items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200/50 shrink-0">
				<span className="text-xs text-base-content/40 mr-1">Compare:</span>
				<button
					type="button"
					onClick={() => setMode("side-by-side")}
					className={`btn btn-xs h-6 min-h-0 px-2 gap-1 ${
						mode === "side-by-side" ? "btn-primary" : "btn-ghost"
					}`}
					title="Side by side"
				>
					<HiViewColumns className="size-3" />
					<span>Split</span>
				</button>
				<button
					type="button"
					onClick={() => setMode("ab-toggle")}
					className={`btn btn-xs h-6 min-h-0 px-2 gap-1 ${
						mode === "ab-toggle" ? "btn-primary" : "btn-ghost"
					}`}
					title="A/B toggle"
				>
					<HiArrowsRightLeft className="size-3" />
					<span>A/B</span>
				</button>
				<div className="flex-1" />
				<span className="text-xs text-base-content/40 tabular-nums">
					{(syncZoom * 100).toFixed(0)}%
				</span>
				{dims && (
					<span className="text-xs text-base-content/40 ml-1">
						{dims.width}×{dims.height}
					</span>
				)}
			</div>

			{mode === "side-by-side" && (
				<div className="flex-1 min-h-0 flex">
					<div className="flex-1 border-r border-base-300 relative">
						<div className="absolute top-2 left-2 z-10 text-xs text-base-content/40 bg-base-200/80 px-2 py-0.5 rounded">
							{beforeLabel}
						</div>
						<TexturePreview
							imageData={beforeImage}
							imageInfo={beforeInfo}
							className="h-full"
							hideToolbar
							controlledZoom={syncZoom}
							controlledPan={syncPan}
							onViewChange={handleViewChange}
						/>
					</div>
					<div className="flex-1 relative">
						<div className="absolute top-2 left-2 z-10 text-xs text-base-content/40 bg-base-200/80 px-2 py-0.5 rounded">
							{afterLabel}
						</div>
						<TexturePreview
							imageData={afterImage ?? beforeImage}
							className="h-full"
							hideToolbar
							controlledZoom={syncZoom}
							controlledPan={syncPan}
							onViewChange={handleViewChange}
						/>
					</div>
				</div>
			)}

			{mode === "ab-toggle" && (
				<div className="flex-1 min-h-0 relative">
					<div className="absolute top-2 left-2 z-10 text-xs text-base-content/40 bg-base-200/80 px-2 py-0.5 rounded">
						{abShowAfter ? afterLabel : beforeLabel}
					</div>
					<button
						type="button"
						onClick={() => setAbShowAfter((v) => !v)}
						className="absolute top-2 right-2 z-10 btn btn-xs h-6 min-h-0 px-2 btn-ghost bg-base-200/80"
						title="Toggle A/B"
					>
						<HiArrowsRightLeft className="size-3" />
					</button>
					<TexturePreview
						imageData={abShowAfter ? (afterImage ?? beforeImage) : beforeImage}
						imageInfo={abShowAfter ? afterInfo : beforeInfo}
						className="h-full"
						hideToolbar
						controlledZoom={syncZoom}
						controlledPan={syncPan}
						onViewChange={handleViewChange}
					/>
				</div>
			)}
		</div>
	);
}

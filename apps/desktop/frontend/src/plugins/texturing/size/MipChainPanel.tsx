// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useEffect, useState, useRef } from "react";
import { useSizeStore } from "@/plugins/texturing/stores/sizeStore";
import {
	computeMipLevels,
	GPU_FORMATS,
	formatBytes,
} from "@/plugins/texturing/size/vramFormats";

const MIN_COL_WIDTH = 28;
const GAP = 12;

export default function MipChainPanel() {
	const info = useSizeStore((s) => s.inputInfo);
	const preview = useSizeStore((s) => s.inputPreview);
	const [mipPreviews, setMipPreviews] = useState<(string | null)[]>([]);
	const [selectedFormat, setSelectedFormat] = useState("BC7");
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(800);

	const mipLevels = useMemo(() => {
		if (!info) return [];
		return computeMipLevels(info.width, info.height);
	}, [info]);

	const format =
		GPU_FORMATS.find((f) => f.name.startsWith(selectedFormat)) ??
		GPU_FORMATS[6];

	// Measure container width for scaling
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setContainerWidth(entry.contentRect.width);
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Generate mip previews asynchronously, smallest first for fast visual feedback
	useEffect(() => {
		if (!preview || mipLevels.length === 0) {
			setMipPreviews([]);
			return;
		}

		// Immediately show all spinners
		setMipPreviews(new Array(mipLevels.length).fill(null));

		let cancelled = false;

		// Defer image load to ensure spinner state paints first
		const raf = requestAnimationFrame(() => {
			if (cancelled) return;

			const img = new Image();
			img.onload = () => {
				if (cancelled) return;

				// Process smallest mips first (they're near-instant)
				const indices = mipLevels.map((_, i) => i).reverse();
				let pos = 0;

				const generateNext = () => {
					if (cancelled || pos >= indices.length) return;
					const idx = indices[pos];
					const lvl = mipLevels[idx];
					const canvas = document.createElement("canvas");
					canvas.width = lvl.width;
					canvas.height = lvl.height;
					const ctx = canvas.getContext("2d")!;
					ctx.imageSmoothingEnabled = true;
					ctx.imageSmoothingQuality = "high";
					ctx.drawImage(img, 0, 0, lvl.width, lvl.height);
					const dataUrl = canvas.toDataURL("image/png");

					setMipPreviews((prev) => {
						const next = [...prev];
						next[idx] = dataUrl;
						return next;
					});

					pos++;
					// Yield to let the browser paint between mips
					setTimeout(generateNext, 0);
				};
				generateNext();
			};
			img.src = preview.startsWith("data:")
				? preview
				: `data:image/png;base64,${preview}`;
		});

		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [preview, mipLevels]);

	if (!info) {
		return (
			<div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
				Load an image to view its mip chain.
			</div>
		);
	}

	const totalSize = mipLevels.reduce(
		(sum, lvl) => sum + format.sizeBytes(lvl.width, lvl.height),
		0,
	);

	// Compute scale so all mips fit in a single row
	const availableWidth = containerWidth - 32;
	const totalNativeWidth = mipLevels.reduce((sum, lvl) => sum + lvl.width, 0);
	const totalGaps = (mipLevels.length - 1) * GAP;

	let scale = Math.min(1, (availableWidth - totalGaps) / totalNativeWidth);
	// Iteratively account for mips that hit minimum column width
	for (let iter = 0; iter < 3; iter++) {
		let sumLarge = 0;
		let countMin = 0;
		for (const lvl of mipLevels) {
			if (lvl.width * scale < MIN_COL_WIDTH) {
				countMin++;
			} else {
				sumLarge += lvl.width;
			}
		}
		if (countMin === 0 || sumLarge === 0) break;
		scale = Math.min(
			1,
			(availableWidth - totalGaps - countMin * MIN_COL_WIDTH) / sumLarge,
		);
	}

	return (
		<div className="flex-1 min-w-0 flex flex-col">
			{/* Header bar */}
			<div className="flex items-center gap-4 px-4 py-2 border-b border-base-300 shrink-0">
				<div className="text-sm font-semibold text-base-content">
					{mipLevels.length} mip levels
				</div>
				<div className="text-xs text-base-content/40">
					{info.width}×{info.height} → 1×1
				</div>
				<div className="flex-1" />
				<div className="flex items-center gap-2">
					<label className="text-xs text-base-content/50">Format:</label>
					<select
						value={selectedFormat}
						onChange={(e) => setSelectedFormat(e.target.value)}
						className="select select-xs select-bordered"
					>
						{GPU_FORMATS.map((f) => (
							<option key={f.name} value={f.name.split(" ")[0]}>
								{f.name}
							</option>
						))}
					</select>
				</div>
				<div className="text-xs font-mono text-base-content/60">
					Total: {formatBytes(totalSize)}
				</div>
			</div>

			{/* Mip cascade — single row, bottom-aligned relative to vertically centered first mip */}
			<div
				ref={containerRef}
				className="flex-1 overflow-hidden p-4 flex items-center"
			>
				<div className="flex items-end" style={{ gap: GAP }}>
					{mipLevels.map((lvl, i) => {
						const displayW = Math.max(
							MIN_COL_WIDTH,
							Math.round(lvl.width * scale),
						);
						const imgW = Math.max(4, Math.round(lvl.width * scale));
						const imgH = Math.max(4, Math.round(lvl.height * scale));
						const levelSize = format.sizeBytes(lvl.width, lvl.height);
						const loaded = mipPreviews[i] != null;

						return (
							<div
								key={i}
								className="flex flex-col items-center gap-1 shrink-0"
								style={{ width: displayW }}
							>
								{/* Mip image */}
								<div
									className="bg-base-300/30 rounded border border-base-300/50 overflow-hidden flex items-center justify-center"
									style={{ width: imgW, height: imgH }}
								>
									{loaded ? (
										<img
											src={mipPreviews[i]!}
											alt={`Mip ${i}`}
											className="w-full h-full"
											style={{
												imageRendering: imgW < 32 ? "pixelated" : "auto",
											}}
										/>
									) : (
										<span
											className="loading loading-spinner"
											style={{
												width: Math.min(16, imgW - 2),
												height: Math.min(16, imgH - 2),
											}}
										/>
									)}
								</div>

								{/* Labels */}
								<div className="text-center whitespace-nowrap">
									<div className="text-xs font-mono text-base-content/60">
										{lvl.width}×{lvl.height}
									</div>
									<div className="text-xs font-mono text-base-content/30">
										{formatBytes(levelSize)}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

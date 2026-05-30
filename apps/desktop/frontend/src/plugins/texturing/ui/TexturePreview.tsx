// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canvas-based texture viewer with channel soloing, wheel-zoom, and pan.
//! Ported from Packi. Accepts base64 (or data:) PNG image data.

import { useRef, useState, useEffect, useCallback } from "react";
import type { ImageInfo } from "@/plugins/texturing/types";

interface TexturePreviewProps {
	imageData: string | null;
	imageInfo?: ImageInfo | null;
	className?: string;
	controlledZoom?: number;
	controlledPan?: { x: number; y: number };
	onViewChange?: (zoom: number, pan: { x: number; y: number }) => void;
	hideToolbar?: boolean;
}

type SoloChannel = "all" | "r" | "g" | "b" | "a";

export default function TexturePreview({
	imageData,
	imageInfo,
	className = "",
	controlledZoom,
	controlledPan,
	onViewChange,
	hideToolbar,
}: TexturePreviewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [internalZoom, setInternalZoom] = useState(1);
	const [internalPan, setInternalPan] = useState({ x: 0, y: 0 });
	const zoom = controlledZoom ?? internalZoom;
	const pan = controlledPan ?? internalPan;

	const updateView = useCallback(
		(newZoom: number, newPan: { x: number; y: number }) => {
			setInternalZoom(newZoom);
			setInternalPan(newPan);
			onViewChange?.(newZoom, newPan);
		},
		[onViewChange],
	);
	const [isPanning, setIsPanning] = useState(false);
	const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
	const [soloChannel, setSoloChannel] = useState<SoloChannel>("all");
	const [fitMode, setFitMode] = useState(true);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const originalDataRef = useRef<ImageData | null>(null);

	const drawImage = useCallback((img: HTMLImageElement, channel: SoloChannel) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.drawImage(img, 0, 0);
		if (channel === "all") return;

		if (!originalDataRef.current) {
			originalDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
		}
		const data = new ImageData(
			new Uint8ClampedArray(originalDataRef.current.data),
			canvas.width,
			canvas.height,
		);
		const px = data.data;
		for (let i = 0; i < px.length; i += 4) {
			let val: number;
			switch (channel) {
				case "r":
					val = px[i];
					break;
				case "g":
					val = px[i + 1];
					break;
				case "b":
					val = px[i + 2];
					break;
				case "a":
					val = px[i + 3];
					break;
				default:
					val = 0;
			}
			px[i] = val;
			px[i + 1] = val;
			px[i + 2] = val;
			px[i + 3] = 255;
		}
		ctx.putImageData(data, 0, 0);
	}, []);

	// Load image when imageData changes.
	useEffect(() => {
		if (!imageData || !canvasRef.current) return;
		const img = new Image();
		img.onload = () => {
			imageRef.current = img;
			originalDataRef.current = null;
			drawImage(img, soloChannel);
			if (fitMode && containerRef.current) {
				const container = containerRef.current;
				const fitZoom = Math.min(
					container.clientWidth / img.width,
					container.clientHeight / img.height,
				);
				updateView(fitZoom, {
					x: (container.clientWidth - img.width * fitZoom) / 2,
					y: (container.clientHeight - img.height * fitZoom) / 2,
				});
			}
		};
		img.src = imageData.startsWith("data:") ? imageData : `data:image/png;base64,${imageData}`;
		// Only re-run when the image data changes (matches Packi).
	}, [imageData]);

	// Redraw when the solo channel changes.
	useEffect(() => {
		if (imageRef.current) drawImage(imageRef.current, soloChannel);
	}, [soloChannel, drawImage]);

	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			e.preventDefault();
			const container = containerRef.current;
			if (!container) return;
			const rect = container.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			const newZoom = Math.min(Math.max(zoom * delta, 0.1), 20);
			const scale = newZoom / zoom;
			updateView(newZoom, {
				x: mouseX - scale * (mouseX - pan.x),
				y: mouseY - scale * (mouseY - pan.y),
			});
			setFitMode(false);
		},
		[zoom, pan, updateView],
	);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return;
			setIsPanning(true);
			panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
		},
		[pan],
	);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (!isPanning) return;
			const dx = e.clientX - panStart.current.x;
			const dy = e.clientY - panStart.current.y;
			updateView(zoom, { x: panStart.current.panX + dx, y: panStart.current.panY + dy });
		},
		[isPanning, zoom, updateView],
	);

	const handleMouseUp = useCallback(() => setIsPanning(false), []);

	const handleFit = useCallback(() => {
		if (!imageRef.current || !containerRef.current) return;
		const container = containerRef.current;
		const img = imageRef.current;
		const fitZoom = Math.min(
			container.clientWidth / img.width,
			container.clientHeight / img.height,
		);
		updateView(fitZoom, {
			x: (container.clientWidth - img.width * fitZoom) / 2,
			y: (container.clientHeight - img.height * fitZoom) / 2,
		});
		setFitMode(true);
	}, [updateView]);

	const handleActual = useCallback(() => {
		updateView(1, { x: 0, y: 0 });
		setFitMode(false);
	}, [updateView]);

	const channelButtons: { id: SoloChannel; label: string; color?: string }[] = [
		{ id: "all", label: "RGB" },
		{ id: "r", label: "R", color: "text-red-400" },
		{ id: "g", label: "G", color: "text-green-400" },
		{ id: "b", label: "B", color: "text-blue-400" },
		{ id: "a", label: "A" },
	];

	return (
		<div className={`flex flex-col h-full ${className}`}>
			{!hideToolbar && (
				<div className="flex items-center gap-1 px-2 py-1 border-b border-base-300 bg-base-200/50 shrink-0">
					<div className="flex items-center gap-0.5 mr-2">
						{channelButtons.map((ch) => (
							<button
								key={ch.id}
								type="button"
								onClick={() => setSoloChannel(ch.id)}
								className={`btn btn-xs h-6 min-h-0 px-2 font-mono text-xs ${
									soloChannel === ch.id ? "btn-primary" : `btn-ghost ${ch.color ?? ""}`
								}`}
							>
								{ch.label}
							</button>
						))}
					</div>
					<div className="flex-1" />
					<button
						type="button"
						onClick={handleFit}
						className={`btn btn-xs h-6 min-h-0 px-2 ${fitMode ? "btn-primary" : "btn-ghost"}`}
					>
						Fit
					</button>
					<button
						type="button"
						onClick={handleActual}
						className={`btn btn-xs h-6 min-h-0 px-2 ${
							!fitMode && zoom === 1 ? "btn-primary" : "btn-ghost"
						}`}
					>
						1:1
					</button>
					<span className="text-xs text-base-content/40 ml-2 tabular-nums">
						{(zoom * 100).toFixed(0)}%
					</span>
					{imageInfo && (
						<span className="text-xs text-base-content/40 ml-1">
							{imageInfo.width}×{imageInfo.height}
						</span>
					)}
				</div>
			)}

			<div
				ref={containerRef}
				className="flex-1 overflow-hidden relative cursor-grab active:cursor-grabbing"
				onWheel={handleWheel}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				style={{
					backgroundImage:
						"linear-gradient(45deg, var(--color-base-300) 25%, transparent 25%, transparent 75%, var(--color-base-300) 75%), linear-gradient(45deg, var(--color-base-300) 25%, transparent 25%, transparent 75%, var(--color-base-300) 75%)",
					backgroundSize: "16px 16px",
					backgroundPosition: "0 0, 8px 8px",
				}}
			>
				{imageData ? (
					<canvas
						ref={canvasRef}
						className="absolute"
						style={{
							transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
							transformOrigin: "0 0",
							imageRendering: zoom > 2 ? "pixelated" : "auto",
						}}
					/>
				) : (
					<div className="flex items-center justify-center h-full text-base-content/30 text-sm">
						No image loaded
					</div>
				)}
			</div>
		</div>
	);
}

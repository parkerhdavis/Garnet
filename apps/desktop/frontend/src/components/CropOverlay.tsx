// SPDX-License-Identifier: AGPL-3.0-or-later
//! Interactive crop-rect overlay. Renders the source image at object-contain
//! into the available canvas area with a darkened mask outside the crop
//! rect, plus 4 corner and 4 edge handles. Internal state for the rect;
//! commits on Done, discards on Cancel — callers don't see intermediate
//! state, so the pipeline isn't polluted with per-frame crop ops.

import { useCallback, useEffect, useRef, useState } from "react";
import { HiCheck, HiXMark } from "react-icons/hi2";

export type CropRect = { x: number; y: number; w: number; h: number };

interface CropOverlayProps {
	/** URL of the image to crop. The overlay applies cssFilter to it so
	 *  the user sees their adjustments while choosing the rect. */
	imgSrc: string;
	/** Source image dimensions (in image pixels). All rect coords are
	 *  in this coordinate space. */
	sourceW: number;
	sourceH: number;
	/** Starting rect; defaults to the full image if null. */
	initial: CropRect | null;
	cssFilter?: string;
	/** Inline SVG <defs> (e.g. the curve / WB filters) so the image can
	 *  still reference them via filter: url(#…) while in crop mode. */
	filterDefs?: React.ReactNode;
	onDone: (crop: CropRect) => void;
	onCancel: () => void;
}

type DragKind = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLE_PX = 14;
const EDGE_PX = 16;
const STROKE_PX = 3;
const MIN_PX = 4;

export default function CropOverlay({
	imgSrc,
	sourceW,
	sourceH,
	initial,
	cssFilter,
	filterDefs,
	onDone,
	onCancel,
}: CropOverlayProps) {
	const [rect, setRect] = useState<CropRect>(
		initial ?? { x: 0, y: 0, w: sourceW, h: sourceH },
	);
	const containerRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const dragRef = useRef<{
		kind: DragKind;
		startMouse: { x: number; y: number };
		startRect: CropRect;
	} | null>(null);

	// Track the img's rendered rect so handles can be a constant on-screen
	// size while the rect itself is expressed in image pixels.
	const [renderedScale, setRenderedScale] = useState<number>(1);

	useEffect(() => {
		const img = imgRef.current;
		if (!img) return;
		const update = () => {
			const r = img.getBoundingClientRect();
			if (r.width > 0 && sourceW > 0) setRenderedScale(r.width / sourceW);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(img);
		window.addEventListener("resize", update);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [sourceW]);

	const eventToImgCoords = useCallback(
		(e: { clientX: number; clientY: number }) => {
			const img = imgRef.current;
			if (!img) return null;
			const r = img.getBoundingClientRect();
			const x = ((e.clientX - r.left) / r.width) * sourceW;
			const y = ((e.clientY - r.top) / r.height) * sourceH;
			return { x, y };
		},
		[sourceW, sourceH],
	);

	function clampRect(r: CropRect): CropRect {
		const x = Math.max(0, Math.min(sourceW - MIN_PX, r.x));
		const y = Math.max(0, Math.min(sourceH - MIN_PX, r.y));
		const w = Math.max(MIN_PX, Math.min(sourceW - x, r.w));
		const h = Math.max(MIN_PX, Math.min(sourceH - y, r.h));
		return { x, y, w, h };
	}

	function startDrag(kind: DragKind, e: React.PointerEvent<Element>) {
		e.stopPropagation();
		const target = e.currentTarget as Element;
		target.setPointerCapture?.(e.pointerId);
		const m = eventToImgCoords(e);
		if (!m) return;
		dragRef.current = { kind, startMouse: m, startRect: rect };
	}

	function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
		const drag = dragRef.current;
		if (!drag) return;
		const m = eventToImgCoords(e);
		if (!m) return;
		const dx = m.x - drag.startMouse.x;
		const dy = m.y - drag.startMouse.y;
		const r0 = drag.startRect;
		const shift = e.shiftKey;
		const alt = e.altKey;

		if (drag.kind === "move") {
			// Move drag — modifiers don't apply.
			const x = Math.max(0, Math.min(sourceW - r0.w, r0.x + dx));
			const y = Math.max(0, Math.min(sourceH - r0.h, r0.y + dy));
			setRect({ x, y, w: r0.w, h: r0.h });
			return;
		}

		// Parameterize the rect as edge positions (l, t, r, b) and figure
		// out which edges the drag kind moves; alt mirrors the opposite
		// edge; shift constrains the resulting rect to the start aspect.
		let l = r0.x;
		let t = r0.y;
		let r = r0.x + r0.w;
		let b = r0.y + r0.h;
		const movesL = drag.kind === "w" || drag.kind === "nw" || drag.kind === "sw";
		const movesR = drag.kind === "e" || drag.kind === "ne" || drag.kind === "se";
		const movesT = drag.kind === "n" || drag.kind === "nw" || drag.kind === "ne";
		const movesB = drag.kind === "s" || drag.kind === "sw" || drag.kind === "se";

		if (movesL) l = r0.x + dx;
		if (movesR) r = r0.x + r0.w + dx;
		if (movesT) t = r0.y + dy;
		if (movesB) b = r0.y + r0.h + dy;

		// Alt: mirror the moving edge(s) about the rect's start center so
		// the resize stays symmetric.
		if (alt) {
			const cx = r0.x + r0.w / 2;
			const cy = r0.y + r0.h / 2;
			if (movesL) r = 2 * cx - l;
			if (movesR) l = 2 * cx - r;
			if (movesT) b = 2 * cy - t;
			if (movesB) t = 2 * cy - b;
		}

		// Shift: snap the new rect to the start aspect ratio.
		if (shift) {
			const aspect = r0.w / r0.h;
			const curW = r - l;
			const curH = b - t;
			const isCorner = (movesL || movesR) && (movesT || movesB);
			if (isCorner) {
				// Use the larger-of-both-relative-to-aspect to pick which
				// dim to clamp — gives the cursor priority on the long axis.
				if (Math.abs(curW) >= Math.abs(curH) * aspect) {
					const newH = Math.sign(curH || 1) * (Math.abs(curW) / aspect);
					if (alt) {
						const cy = r0.y + r0.h / 2;
						t = cy - newH / 2;
						b = cy + newH / 2;
					} else if (movesT) {
						t = b - newH;
					} else {
						b = t + newH;
					}
				} else {
					const newW = Math.sign(curW || 1) * (Math.abs(curH) * aspect);
					if (alt) {
						const cx = r0.x + r0.w / 2;
						l = cx - newW / 2;
						r = cx + newW / 2;
					} else if (movesL) {
						l = r - newW;
					} else {
						r = l + newW;
					}
				}
			} else if (movesL || movesR) {
				// Horizontal edge drag — adjust height to match aspect,
				// centered on the rect's start y-center.
				const newH = (r - l) / aspect;
				const cy = r0.y + r0.h / 2;
				t = cy - newH / 2;
				b = cy + newH / 2;
			} else {
				// Vertical edge drag — adjust width, centered on x-center.
				const newW = (b - t) * aspect;
				const cx = r0.x + r0.w / 2;
				l = cx - newW / 2;
				r = cx + newW / 2;
			}
		}

		// Re-sort if the drag crossed the opposite edge.
		if (r < l) [l, r] = [r, l];
		if (b < t) [t, b] = [b, t];
		setRect(clampRect({ x: l, y: t, w: r - l, h: b - t }));
	}

	function onPointerUp() {
		dragRef.current = null;
	}

	// Keyboard: Enter commits, Esc cancels.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
			} else if (e.key === "Enter") {
				e.preventDefault();
				onDone(toIntRect(rect));
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [rect, onDone, onCancel]);

	const handleSize = HANDLE_PX / renderedScale; // image-px size that renders ~HANDLE_PX
	const edgeSize = EDGE_PX / renderedScale;
	const strokeW = STROKE_PX / renderedScale;

	return (
		<div
			ref={containerRef}
			className="absolute inset-0 flex flex-col items-stretch bg-base-300/30"
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		>
			<div className="flex-1 min-h-0 flex items-center justify-center relative p-4">
				<div className="relative max-w-full max-h-full">
					{/* The inline SVG <defs> need to live in the DOM for filter
					    URLs to resolve; render them as a 0×0 svg if provided. */}
					{filterDefs && (
						<svg
							aria-hidden
							width={0}
							height={0}
							style={{ position: "absolute", width: 0, height: 0 }}
						>
							{filterDefs}
						</svg>
					)}
					<img
						ref={imgRef}
						src={imgSrc}
						alt="Crop"
						className="block max-w-full max-h-[calc(100vh-12rem)] object-contain select-none"
						style={cssFilter ? { filter: cssFilter } : undefined}
						draggable={false}
					/>
					{/* SVG overlay matched to the img via absolute inset-0 +
					    viewBox in image-pixel coords. */}
					<svg
						className="absolute inset-0 w-full h-full"
						viewBox={`0 0 ${sourceW} ${sourceH}`}
						preserveAspectRatio="none"
					>
						{/* Darkened mask — four rects around the crop rect. */}
						<g fill="rgba(0,0,0,0.55)">
							<rect x={0} y={0} width={sourceW} height={rect.y} />
							<rect
								x={0}
								y={rect.y + rect.h}
								width={sourceW}
								height={sourceH - (rect.y + rect.h)}
							/>
							<rect x={0} y={rect.y} width={rect.x} height={rect.h} />
							<rect
								x={rect.x + rect.w}
								y={rect.y}
								width={sourceW - (rect.x + rect.w)}
								height={rect.h}
							/>
						</g>
						{/* Interior — draggable. */}
						<rect
							x={rect.x}
							y={rect.y}
							width={rect.w}
							height={rect.h}
							fill="transparent"
							stroke="white"
							strokeWidth={strokeW}
							style={{ cursor: "move" }}
							onPointerDown={(e) => startDrag("move", e)}
						/>
						{/* Thirds guides */}
						<g
							stroke="rgba(255,255,255,0.35)"
							strokeWidth={strokeW * 0.6}
							pointerEvents="none"
						>
							<line
								x1={rect.x + rect.w / 3}
								y1={rect.y}
								x2={rect.x + rect.w / 3}
								y2={rect.y + rect.h}
							/>
							<line
								x1={rect.x + (2 * rect.w) / 3}
								y1={rect.y}
								x2={rect.x + (2 * rect.w) / 3}
								y2={rect.y + rect.h}
							/>
							<line
								x1={rect.x}
								y1={rect.y + rect.h / 3}
								x2={rect.x + rect.w}
								y2={rect.y + rect.h / 3}
							/>
							<line
								x1={rect.x}
								y1={rect.y + (2 * rect.h) / 3}
								x2={rect.x + rect.w}
								y2={rect.y + (2 * rect.h) / 3}
							/>
						</g>
						{/* Edge handles (long thin strips) */}
						<EdgeHandle
							kind="n"
							rect={rect}
							edgeSize={edgeSize}
							sourceW={sourceW}
							sourceH={sourceH}
							onStart={startDrag}
						/>
						<EdgeHandle
							kind="s"
							rect={rect}
							edgeSize={edgeSize}
							sourceW={sourceW}
							sourceH={sourceH}
							onStart={startDrag}
						/>
						<EdgeHandle
							kind="e"
							rect={rect}
							edgeSize={edgeSize}
							sourceW={sourceW}
							sourceH={sourceH}
							onStart={startDrag}
						/>
						<EdgeHandle
							kind="w"
							rect={rect}
							edgeSize={edgeSize}
							sourceW={sourceW}
							sourceH={sourceH}
							onStart={startDrag}
						/>
						{/* Corner handles */}
						<CornerHandle
							kind="nw"
							rect={rect}
							handleSize={handleSize}
							onStart={startDrag}
						/>
						<CornerHandle
							kind="ne"
							rect={rect}
							handleSize={handleSize}
							onStart={startDrag}
						/>
						<CornerHandle
							kind="sw"
							rect={rect}
							handleSize={handleSize}
							onStart={startDrag}
						/>
						<CornerHandle
							kind="se"
							rect={rect}
							handleSize={handleSize}
							onStart={startDrag}
						/>
					</svg>
				</div>
			</div>
			<div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-base-300 bg-base-100 text-xs">
				<span className="text-base-content/60 font-mono shrink-0">
					{Math.round(rect.w)} × {Math.round(rect.h)} px @ {Math.round(rect.x)},
					{Math.round(rect.y)}
				</span>
				<span className="text-[10px] text-base-content/40 truncate hidden sm:inline">
					Shift = preserve aspect · Alt = symmetric · Enter = done · Esc = cancel
				</span>
				<div className="flex gap-1.5 shrink-0">
					<button type="button" className="btn btn-xs" onClick={onCancel}>
						<HiXMark className="size-3.5" />
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-xs btn-primary"
						onClick={() => onDone(toIntRect(rect))}
					>
						<HiCheck className="size-3.5" />
						Done
					</button>
				</div>
			</div>
		</div>
	);
}

function toIntRect(r: CropRect): CropRect {
	return {
		x: Math.max(0, Math.round(r.x)),
		y: Math.max(0, Math.round(r.y)),
		w: Math.max(1, Math.round(r.w)),
		h: Math.max(1, Math.round(r.h)),
	};
}

function CornerHandle({
	kind,
	rect,
	handleSize,
	onStart,
}: {
	kind: "nw" | "ne" | "sw" | "se";
	rect: CropRect;
	handleSize: number;
	onStart: (kind: DragKind, e: React.PointerEvent<Element>) => void;
}) {
	const x = kind === "nw" || kind === "sw" ? rect.x : rect.x + rect.w;
	const y = kind === "nw" || kind === "ne" ? rect.y : rect.y + rect.h;
	const cursor =
		kind === "nw" || kind === "se" ? "nwse-resize" : "nesw-resize";
	return (
		<rect
			x={x - handleSize / 2}
			y={y - handleSize / 2}
			width={handleSize}
			height={handleSize}
			fill="white"
			stroke="rgba(0,0,0,0.6)"
			strokeWidth={Math.max(handleSize * 0.05, 0.5)}
			style={{ cursor }}
			onPointerDown={(e) => onStart(kind, e)}
		/>
	);
}

function EdgeHandle({
	kind,
	rect,
	edgeSize,
	sourceW: _sourceW,
	sourceH: _sourceH,
	onStart,
}: {
	kind: "n" | "s" | "e" | "w";
	rect: CropRect;
	edgeSize: number;
	sourceW: number;
	sourceH: number;
	onStart: (kind: DragKind, e: React.PointerEvent<Element>) => void;
}) {
	let x = rect.x;
	let y = rect.y;
	let w = rect.w;
	let h = rect.h;
	let cursor: string;
	switch (kind) {
		case "n":
			y = rect.y - edgeSize / 2;
			h = edgeSize;
			cursor = "ns-resize";
			break;
		case "s":
			y = rect.y + rect.h - edgeSize / 2;
			h = edgeSize;
			cursor = "ns-resize";
			break;
		case "e":
			x = rect.x + rect.w - edgeSize / 2;
			w = edgeSize;
			cursor = "ew-resize";
			break;
		case "w":
			x = rect.x - edgeSize / 2;
			w = edgeSize;
			cursor = "ew-resize";
			break;
	}
	return (
		<rect
			x={x}
			y={y}
			width={w}
			height={h}
			fill="transparent"
			style={{ cursor }}
			onPointerDown={(e) => onStart(kind, e)}
		/>
	);
}

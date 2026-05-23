// SPDX-License-Identifier: AGPL-3.0-or-later
//! Client-side geometric renderer for the image editor's canvas. Composes
//! crop + resize + rotate + corner-round into a layered CSS structure so
//! previews are full-resolution and round-trip-free. Adjustment filters
//! (cssFilter) apply to the img element at the innermost layer.
//!
//! Layered structure (inside to out):
//!   <img>              source pixels, with CSS filter chain
//!   crop wrapper       overflow:hidden + percent-positioned img, border-radius
//!   rotation wrapper   transform: rotate(angle), sized to output aspect
//!   outer bbox         aspect-ratio = rotated bbox aspect, max-w/h capped
//!
//! When no geometric ops are present this collapses to a plain img with
//! object-contain — the original fast path.

import { useCallback, useRef, useState } from "react";
import type { Operation } from "@/stores/editorStore";

export interface EditorCanvasProps {
	imgSrc: string;
	sourceW: number;
	sourceH: number;
	cssOps: Operation[];
	cssFilter: string;
}

export default function EditorCanvas({
	imgSrc,
	sourceW,
	sourceH,
	cssOps,
	cssFilter,
}: EditorCanvasProps) {
	const geom = computeGeometry(cssOps, sourceW, sourceH);

	// Track the cropped wrapper's rendered width to scale the corner radius
	// from output pixels into screen pixels. Uses a callback ref so the
	// ResizeObserver re-attaches whenever the wrapper appears/disappears
	// in the DOM — the wrapper is only rendered when geometric ops are
	// active, so a one-shot useEffect would miss the first attach.
	const [renderedOutputW, setRenderedOutputW] = useState<number | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const cropWrapperRef = useCallback((node: HTMLDivElement | null) => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		if (!node) {
			setRenderedOutputW(null);
			return;
		}
		const update = () => {
			const w = node.getBoundingClientRect().width;
			if (w > 0) setRenderedOutputW(w);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(node);
		observerRef.current = ro;
	}, []);

	const radiusScale = renderedOutputW && geom.outputW > 0 ? renderedOutputW / geom.outputW : 0;
	const radiusPx = geom.cornerRadiusOutput > 0 ? geom.cornerRadiusOutput * radiusScale : 0;

	// Empty pipeline fast path: plain img with object-contain.
	if (!geom.anyGeometric) {
		return (
			<img
				src={imgSrc}
				alt="Edited preview"
				className="max-w-full max-h-full object-contain"
				style={cssFilter ? { filter: cssFilter } : undefined}
			/>
		);
	}

	// Compute the rotated bbox aspect. Identity rotation reduces to the
	// output aspect; 90/270 swap; arbitrary angles get the trig formula.
	const angleRad = (geom.rotationDeg * Math.PI) / 180;
	const cos = Math.abs(Math.cos(angleRad));
	const sin = Math.abs(Math.sin(angleRad));
	const bbW = geom.outputW * cos + geom.outputH * sin;
	const bbH = geom.outputW * sin + geom.outputH * cos;
	const bbAspect = bbW / bbH;

	const innerImg = (
		<img
			src={imgSrc}
			alt="Edited preview"
			className="absolute top-0 left-0"
			style={{
				width: `${(sourceW / geom.regionW) * 100}%`,
				height: `${(sourceH / geom.regionH) * 100}%`,
				left: `${(-geom.regionX / geom.regionW) * 100}%`,
				top: `${(-geom.regionY / geom.regionH) * 100}%`,
				maxWidth: "none",
				maxHeight: "none",
				filter: cssFilter || undefined,
				// Prevent the img's default object-fit:fill from showing edges
				// of the source outside the crop region.
				display: "block",
			}}
			draggable={false}
		/>
	);

	const cropWrapper = (
		<div
			ref={cropWrapperRef}
			className="relative overflow-hidden w-full h-full"
			style={{
				borderRadius: radiusPx > 0 ? `${radiusPx}px` : undefined,
			}}
		>
			{innerImg}
		</div>
	);

	// No rotation: skip the bbox + rotation wrappers.
	if (geom.rotationDeg === 0) {
		return (
			<div
				className="relative max-w-full max-h-full"
				style={{
					aspectRatio: `${geom.outputW} / ${geom.outputH}`,
					// Honor the canvas area's bounds — let aspect drive whichever
					// dim is the binding constraint.
					width: `min(100%, calc((100vh - 12rem) * ${geom.outputW / geom.outputH}))`,
				}}
			>
				{cropWrapper}
			</div>
		);
	}

	return (
		<div
			className="relative max-w-full max-h-full"
			style={{
				aspectRatio: `${bbW} / ${bbH}`,
				width: `min(100%, calc((100vh - 12rem) * ${bbAspect}))`,
			}}
		>
			<div
				style={{
					position: "absolute",
					top: "50%",
					left: "50%",
					width: `${(geom.outputW / bbW) * 100}%`,
					aspectRatio: `${geom.outputW} / ${geom.outputH}`,
					transform: `translate(-50%, -50%) rotate(${geom.rotationDeg}deg)`,
					transformOrigin: "center",
				}}
			>
				{cropWrapper}
			</div>
		</div>
	);
}

interface Geometry {
	/** Region of the source img to display. */
	regionX: number;
	regionY: number;
	regionW: number;
	regionH: number;
	/** Dimensions of the OUTPUT (post-resize) used for aspect + corner-radius math. */
	outputW: number;
	outputH: number;
	/** Total rotation in degrees. */
	rotationDeg: number;
	/** Corner radius in output-space pixels (gets scaled to screen px at render). */
	cornerRadiusOutput: number;
	/** True if any geometric op is present (else use the fast path). */
	anyGeometric: boolean;
}

export function computeGeometry(
	ops: Operation[],
	sourceW: number,
	sourceH: number,
): Geometry {
	let regionX = 0;
	let regionY = 0;
	let regionW = sourceW;
	let regionH = sourceH;
	let outputW = sourceW;
	let outputH = sourceH;
	let rotationDeg = 0;
	let cornerRadiusOutput = 0;
	let anyGeometric = false;

	for (const op of ops) {
		switch (op.type) {
			case "crop":
				regionX = op.x;
				regionY = op.y;
				regionW = op.w;
				regionH = op.h;
				// Crop also resets output dims to the crop dims unless a
				// later resize overrides.
				outputW = op.w;
				outputH = op.h;
				anyGeometric = true;
				break;
			case "resize":
				outputW = op.w;
				outputH = op.h;
				anyGeometric = true;
				break;
			case "rotate":
				rotationDeg = (((rotationDeg + op.angle) % 360) + 360) % 360;
				anyGeometric = true;
				break;
			case "corner_round":
				cornerRadiusOutput = op.radius;
				anyGeometric = true;
				break;
		}
	}

	return {
		regionX,
		regionY,
		regionW,
		regionH,
		outputW,
		outputH,
		rotationDeg,
		cornerRadiusOutput,
		anyGeometric,
	};
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! A small SVG-based luminance-curve editor. Control points live in
//! normalized [0,1] curve-space (x = input intensity, y = output intensity).
//! The curve is a monotonic-cubic spline so dragging an interior point
//! never overshoots into wiggles that would invert the LUT mapping.
//!
//! The editor is intentionally minimal — no canvas, no UMD dep, no
//! external library. The companion CurveEditor in Packi uses
//! `canvasSpliner`; we deliberately avoid that here to keep Garnet free
//! of github-hosted module dependencies.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type CurvePoint = { x: number; y: number };

const PAD = 10; // SVG pad so endpoint handles don't clip
const PT_R = 5; // control point radius (px)
const HIT_R = 10; // hit radius for double-click-to-remove

const DEFAULT_POINTS: CurvePoint[] = [
	{ x: 0, y: 0 },
	{ x: 1, y: 1 },
];

interface CurveEditorProps {
	/** Initial points (curve-space, normalized 0-1). */
	points?: CurvePoint[];
	/** Width and height of the curve area in CSS pixels (excludes pad). */
	width?: number;
	height?: number;
	/** Fires on every pointermove during a drag, plus add / remove.
	 *  Use for cheap live-preview updates (e.g. CSS-filter overlays).
	 *  Coalesce on the consumer side — this fires at pointer rate. */
	onChangeLive?: (points: CurvePoint[], lut: number[]) => void;
	/** Fires once at drag-end (pointerup) or after add / remove. Use for
	 *  expensive work, undo bookkeeping, or anything that should happen
	 *  once per gesture rather than per frame. */
	onChangeCommit?: (points: CurvePoint[], lut: number[]) => void;
	/** Optional 256-bin luminance histogram drawn behind the curve. */
	histogramBins?: Uint32Array | null;
}

export default function CurveEditor({
	points: initialPoints,
	width = 220,
	height = 220,
	onChangeLive,
	onChangeCommit,
	histogramBins,
}: CurveEditorProps) {
	const [points, setPoints] = useState<CurvePoint[]>(
		initialPoints ?? DEFAULT_POINTS,
	);
	const svgRef = useRef<SVGSVGElement>(null);
	const dragRef = useRef<{ index: number; isEndpoint: boolean } | null>(null);

	const svgW = width + 2 * PAD;
	const svgH = height + 2 * PAD;

	const xToSvg = useCallback((x: number) => PAD + x * width, [width]);
	const yToSvg = useCallback((y: number) => PAD + (1 - y) * height, [height]);
	const svgToCurve = useCallback(
		(sx: number, sy: number): CurvePoint => ({
			x: clamp01((sx - PAD) / width),
			y: clamp01(1 - (sy - PAD) / height),
		}),
		[width, height],
	);

	const lut = useMemo(() => buildLut(points), [points]);
	const pathD = useMemo(
		() => splinePath(points, xToSvg, yToSvg),
		[points, xToSvg, yToSvg],
	);

	const histogramBars = useMemo(() => {
		if (!histogramBins) return null;
		let max = 0;
		for (let i = 1; i < 255; i++)
			if (histogramBins[i] > max) max = histogramBins[i];
		const cap = Math.max(max * 2, 1);
		const bars: { x: number; y: number; w: number; h: number }[] = [];
		const barW = width / 256;
		for (let i = 1; i < 255; i++) {
			const v = Math.min(histogramBins[i], cap);
			const h = (v / cap) * height;
			bars.push({
				x: PAD + i * barW,
				y: PAD + height - h,
				w: Math.max(barW, 1),
				h,
			});
		}
		return bars;
	}, [histogramBins, width, height]);

	function localCoords(e: { clientX: number; clientY: number }): {
		x: number;
		y: number;
	} | null {
		const svg = svgRef.current;
		if (!svg) return null;
		const rect = svg.getBoundingClientRect();
		return {
			x: ((e.clientX - rect.left) / rect.width) * svgW,
			y: ((e.clientY - rect.top) / rect.height) * svgH,
		};
	}

	function onPointDown(index: number, e: React.PointerEvent<SVGCircleElement>) {
		e.stopPropagation();
		(e.target as Element).setPointerCapture?.(e.pointerId);
		dragRef.current = {
			index,
			isEndpoint: index === 0 || index === points.length - 1,
		};
	}

	function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
		const drag = dragRef.current;
		if (!drag) return;
		const local = localCoords(e);
		if (!local) return;
		const c = svgToCurve(local.x, local.y);
		setPoints((prev) => {
			const next = prev.slice();
			const fixedX = drag.isEndpoint ? prev[drag.index].x : c.x;
			// Keep neighbours strictly sorted by x so the spline stays
			// monotonic in x (otherwise the LUT becomes ill-defined).
			let x = fixedX;
			if (!drag.isEndpoint) {
				const left = prev[drag.index - 1].x + 0.001;
				const right = prev[drag.index + 1].x - 0.001;
				x = Math.min(right, Math.max(left, c.x));
			}
			next[drag.index] = { x, y: c.y };
			onChangeLive?.(next, buildLut(next));
			return next;
		});
	}

	function onPointerUp() {
		if (!dragRef.current) return;
		dragRef.current = null;
		onChangeCommit?.(points, lut);
	}

	function onSvgDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
		const local = localCoords(e);
		if (!local) return;
		// Try to remove a nearby interior point first.
		const removeIdx = nearestPointIndex(points, local, xToSvg, yToSvg, HIT_R);
		if (removeIdx > 0 && removeIdx < points.length - 1) {
			const next = points.filter((_, i) => i !== removeIdx);
			setPoints(next);
			const nextLut = buildLut(next);
			onChangeLive?.(next, nextLut);
			onChangeCommit?.(next, nextLut);
			return;
		}
		// Otherwise insert a new point at the click position.
		const c = svgToCurve(local.x, local.y);
		// Skip if it would land too close to an existing point on x.
		if (points.some((p) => Math.abs(p.x - c.x) < 0.01)) return;
		const next = [...points, c].sort((a, b) => a.x - b.x);
		setPoints(next);
		const nextLut = buildLut(next);
		onChangeLive?.(next, nextLut);
		onChangeCommit?.(next, nextLut);
	}

	// Defensive: release capture if the pointer leaves the document.
	useEffect(() => {
		const handler = () => {
			if (dragRef.current) {
				dragRef.current = null;
				onChangeCommit?.(points, lut);
			}
		};
		window.addEventListener("pointerup", handler);
		return () => window.removeEventListener("pointerup", handler);
	}, [points, lut, onChangeCommit]);

	return (
		<svg
			ref={svgRef}
			width={svgW}
			height={svgH}
			viewBox={`0 0 ${svgW} ${svgH}`}
			className="select-none touch-none rounded-md border border-base-300 bg-base-200/40 text-primary"
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onDoubleClick={onSvgDoubleClick}
		>
			{/* Histogram */}
			{histogramBars?.map((b, i) => (
				<rect
					key={i}
					x={b.x}
					y={b.y}
					width={b.w}
					height={b.h}
					fill="rgba(255,255,255,0.07)"
				/>
			))}
			{/* Grid: quarters */}
			{[0.25, 0.5, 0.75].map((t) => (
				<g key={t} stroke="rgba(255,255,255,0.08)" strokeWidth={1}>
					<line
						x1={PAD + t * width}
						y1={PAD}
						x2={PAD + t * width}
						y2={PAD + height}
					/>
					<line
						x1={PAD}
						y1={PAD + t * height}
						x2={PAD + width}
						y2={PAD + t * height}
					/>
				</g>
			))}
			{/* Outer frame + identity diagonal */}
			<rect
				x={PAD}
				y={PAD}
				width={width}
				height={height}
				fill="none"
				stroke="rgba(255,255,255,0.15)"
				strokeWidth={1}
			/>
			<line
				x1={PAD}
				y1={PAD + height}
				x2={PAD + width}
				y2={PAD}
				stroke="rgba(255,255,255,0.1)"
				strokeWidth={1}
				strokeDasharray="3 3"
			/>
			{/* The curve */}
			<path d={pathD} fill="none" stroke="currentColor" strokeWidth={2} />
			{/* Control points */}
			{points.map((p, i) => (
				<circle
					key={i}
					cx={xToSvg(p.x)}
					cy={yToSvg(p.y)}
					r={PT_R}
					fill="rgba(220,220,220,0.9)"
					stroke="currentColor"
					strokeWidth={1.5}
					style={{ cursor: "grab" }}
					onPointerDown={(e) => onPointDown(i, e)}
				/>
			))}
		</svg>
	);
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

/** Build a 256-entry LUT from the control points using the monotonic spline. */
export function buildLut(points: CurvePoint[]): number[] {
	const lut = new Array<number>(256);
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const ms = monotonicTangents(xs, ys);
	for (let i = 0; i < 256; i++) {
		const x = i / 255;
		const y = evalSpline(xs, ys, ms, x);
		lut[i] = Math.round(clamp01(y) * 255);
	}
	return lut;
}

/** Build a smooth SVG path from the same monotonic spline. */
function splinePath(
	points: CurvePoint[],
	xToSvg: (x: number) => number,
	yToSvg: (y: number) => number,
): string {
	if (points.length < 2) {
		// Single point — render as a horizontal line at that y.
		const p = points[0] ?? { x: 0, y: 0 };
		return `M ${xToSvg(0)} ${yToSvg(p.y)} L ${xToSvg(1)} ${yToSvg(p.y)}`;
	}
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const ms = monotonicTangents(xs, ys);
	const parts: string[] = [];
	parts.push(`M ${xToSvg(xs[0])} ${yToSvg(ys[0])}`);
	// Cubic Hermite → cubic Bezier conversion per segment:
	// control points at ±(h/3) of the tangents.
	for (let i = 0; i < xs.length - 1; i++) {
		const h = xs[i + 1] - xs[i];
		const c1x = xs[i] + h / 3;
		const c1y = ys[i] + (ms[i] * h) / 3;
		const c2x = xs[i + 1] - h / 3;
		const c2y = ys[i + 1] - (ms[i + 1] * h) / 3;
		parts.push(
			`C ${xToSvg(c1x)} ${yToSvg(c1y)} ${xToSvg(c2x)} ${yToSvg(c2y)} ${xToSvg(xs[i + 1])} ${yToSvg(ys[i + 1])}`,
		);
	}
	return parts.join(" ");
}

/** Fritsch–Carlson monotonic cubic tangents — guarantees no overshoot. */
function monotonicTangents(xs: number[], ys: number[]): number[] {
	const n = xs.length;
	if (n === 0) return [];
	if (n === 1) return [0];
	const d: number[] = new Array(n - 1);
	for (let i = 0; i < n - 1; i++)
		d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
	const m: number[] = new Array(n);
	m[0] = d[0];
	m[n - 1] = d[n - 2];
	for (let i = 1; i < n - 1; i++) {
		if (d[i - 1] * d[i] <= 0) m[i] = 0;
		else m[i] = (d[i - 1] + d[i]) / 2;
	}
	for (let i = 0; i < n - 1; i++) {
		if (d[i] === 0) {
			m[i] = 0;
			m[i + 1] = 0;
			continue;
		}
		const a = m[i] / d[i];
		const b = m[i + 1] / d[i];
		const s = a * a + b * b;
		if (s > 9) {
			const t = 3 / Math.sqrt(s);
			m[i] = t * a * d[i];
			m[i + 1] = t * b * d[i];
		}
	}
	return m;
}

function evalSpline(
	xs: number[],
	ys: number[],
	ms: number[],
	x: number,
): number {
	const n = xs.length;
	if (n === 0) return 0;
	if (x <= xs[0]) return ys[0];
	if (x >= xs[n - 1]) return ys[n - 1];
	// Binary search for the bracketing segment.
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= x) lo = mid;
		else hi = mid;
	}
	const h = xs[hi] - xs[lo];
	const t = (x - xs[lo]) / h;
	const t2 = t * t;
	const t3 = t2 * t;
	const h00 = 2 * t3 - 3 * t2 + 1;
	const h10 = t3 - 2 * t2 + t;
	const h01 = -2 * t3 + 3 * t2;
	const h11 = t3 - t2;
	return h00 * ys[lo] + h10 * h * ms[lo] + h01 * ys[hi] + h11 * h * ms[hi];
}

function nearestPointIndex(
	points: CurvePoint[],
	local: { x: number; y: number },
	xToSvg: (x: number) => number,
	yToSvg: (y: number) => number,
	maxR: number,
): number {
	let best = -1;
	let bestD = maxR * maxR;
	for (let i = 0; i < points.length; i++) {
		const dx = xToSvg(points[i].x) - local.x;
		const dy = yToSvg(points[i].y) - local.y;
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

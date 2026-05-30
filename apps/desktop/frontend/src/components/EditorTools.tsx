// SPDX-License-Identifier: AGPL-3.0-or-later
//! Right-hand tools panel for the image editor: adjust sliders (hue,
//! saturation, brightness, contrast) and transform tools (crop, resize,
//! rotate, corner-round). Slider drags coalesce into a single op via
//! `replaceLastOfType` and push one combined undo entry on pointer-up;
//! click-style tools (rotate buttons, Apply) push one op + one undo entry.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	HiArrowPath,
	HiArrowUturnLeft,
	HiArrowUturnRight,
	HiScissors,
	HiSparkles,
	HiSquare2Stack,
	HiSwatch,
} from "react-icons/hi2";
import CurveEditor, { type CurvePoint } from "@/components/CurveEditor";
import { type Operation, useEditorStore } from "@/stores/editorStore";
import { useUndoStore } from "@/stores/undoStore";

/// Hide the transform tools until their backend preview path is sorted.
/// Backend `editor::transform` + commands are intact and unit-tested;
/// flip this back on once the frontend integration is debugged. See
/// `40-69 Projects/41 PhD - Software/Garnet/90-99 Agents/Transient/
/// editor-transform-tools-todo.md` for resume notes.
const TRANSFORM_TOOLS_ENABLED = true;

export function EditorTools({
	sourceDims,
}: { sourceDims: { w: number; h: number } | null }) {
	return (
		<aside className="w-72 shrink-0 border-l border-base-300 bg-base-100 overflow-y-auto">
			<Section
				title="Adjustments"
				icon={<HiSwatch className="size-3.5" />}
				last={!TRANSFORM_TOOLS_ENABLED}
			>
				<AdjustSlider
					type="adjust_hue"
					label="Hue"
					min={-180}
					max={180}
					step={1}
					unit="°"
				/>
				<AdjustSlider
					type="adjust_saturation"
					label="Saturation"
					min={-1}
					max={1}
					step={0.01}
				/>
				<AdjustSlider
					type="adjust_brightness"
					label="Brightness"
					min={-1}
					max={1}
					step={0.01}
				/>
				<AdjustSlider
					type="adjust_contrast"
					label="Contrast"
					min={-1}
					max={1}
					step={0.01}
				/>
				<AdjustSlider
					type="adjust_temperature"
					label="Temperature"
					min={-1}
					max={1}
					step={0.01}
				/>
				<AdjustSlider
					type="adjust_tint"
					label="Tint"
					min={-1}
					max={1}
					step={0.01}
				/>
				<div className="pt-2">
					<div className="text-[10px] uppercase tracking-wider text-base-content/45 font-semibold mb-1.5">
						Luminance curve
					</div>
					<CurveTool />
				</div>
			</Section>

			{TRANSFORM_TOOLS_ENABLED && (
				<>
					<Section title="Crop" icon={<HiScissors className="size-3.5" />}>
						<CropTool sourceDims={sourceDims} />
					</Section>

					<Section
						title="Resize"
						icon={<HiSquare2Stack className="size-3.5" />}
					>
						<ResizeTool sourceDims={sourceDims} />
					</Section>

					<Section title="Rotate" icon={<HiArrowPath className="size-3.5" />}>
						<RotateTool />
					</Section>

					<Section
						title="Corner round"
						icon={<HiSparkles className="size-3.5" />}
						last
					>
						<CornerRoundTool sourceDims={sourceDims} />
					</Section>
				</>
			)}
		</aside>
	);
}

function Section({
	title,
	icon,
	children,
	last,
}: {
	title: string;
	icon?: React.ReactNode;
	children: React.ReactNode;
	last?: boolean;
}) {
	return (
		<section className={`px-4 py-3 ${last ? "" : "border-b border-base-300"}`}>
			<div className="text-[10px] uppercase tracking-wider text-base-content/55 font-semibold mb-2 flex items-center gap-1.5">
				{icon}
				{title}
			</div>
			<div className="space-y-2">{children}</div>
		</section>
	);
}

/** Numeric readout that swaps to an input on double-click. Commits via
 *  Enter or blur, cancels via Escape; clamps to [min, max] before
 *  calling onCommit. The parent owns the value and undo bookkeeping —
 *  this component is presentational only. */
function EditableValue({
	value,
	min,
	max,
	step,
	display,
	onCommit,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
	display: ReactNode;
	onCommit: (v: number) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editing]);

	function startEdit() {
		setText(value.toString());
		setEditing(true);
	}

	function commit() {
		setEditing(false);
		const v = Number(text);
		if (!Number.isFinite(v)) return;
		const clamped = Math.max(min, Math.min(max, v));
		if (clamped === value) return;
		onCommit(clamped);
	}

	// Both modes occupy an identical box so the layout doesn't jump when
	// double-clicking to edit. The span carries a transparent border + the
	// same padding as the input, so swapping in the bordered input is a
	// pure cosmetic change.
	const sharedBox =
		"h-5 w-14 px-1 border rounded font-mono text-[11px] text-right box-border";

	if (editing) {
		return (
			<input
				ref={inputRef}
				type="number"
				className={`${sharedBox} input input-xs input-bordered min-h-0 py-0 leading-none`}
				value={text}
				min={min}
				max={max}
				step={step}
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						setEditing(false);
					}
				}}
			/>
		);
	}

	return (
		<span
			className={`${sharedBox} inline-flex items-center justify-end border-transparent text-base-content/60 cursor-text select-none leading-none`}
			onDoubleClick={startEdit}
			title="Double-click to edit"
		>
			{display}
		</span>
	);
}

/** Wraps a numeric slider for an "adjust_*" op so the slider drag coalesces
 *  into one op and one undo entry. */
type AdjustSliderType =
	| "adjust_hue"
	| "adjust_saturation"
	| "adjust_brightness"
	| "adjust_contrast"
	| "adjust_temperature"
	| "adjust_tint";

/** Ops carry their value under `amount` vs `offset` depending on type;
 *  centralize the mapping here so AdjustSlider can stay generic. */
const AMOUNT_OPS = new Set<AdjustSliderType>([
	"adjust_contrast",
	"adjust_temperature",
	"adjust_tint",
]);

function AdjustSlider({
	type,
	label,
	min,
	max,
	step,
	unit,
}: {
	type: AdjustSliderType;
	label: string;
	min: number;
	max: number;
	step: number;
	unit?: string;
}) {
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const pushOp = useEditorStore((s) => s.pushOp);
	const setOps = useEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);

	const isAmount = AMOUNT_OPS.has(type);

	const currentValue = (() => {
		for (let i = pendingOps.length - 1; i >= 0; i--) {
			const op = pendingOps[i];
			if (op.type === type) {
				// biome-ignore lint/suspicious/noExplicitAny: discriminated union narrowing already done by op.type === type
				return isAmount ? (op as any).amount : (op as any).offset;
			}
		}
		return 0;
	})();

	const beforeOpsRef = useRef<Operation[] | null>(null);

	function makeOp(value: number): Operation {
		if (isAmount) return { type, amount: value } as Operation;
		return { type, offset: value } as Operation;
	}

	function resetToDefault() {
		const before = useEditorStore.getState().pendingOps;
		const next = before.filter((o) => o.type !== type);
		if (sameOps(before, next)) return;
		void setOps(next);
		undoPush({
			description: `Reset ${label}`,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	function commitTyped(v: number) {
		const before = useEditorStore.getState().pendingOps;
		void pushOp(makeOp(v), { replaceLastOfType: true });
		queueMicrotask(() => {
			const after = useEditorStore.getState().pendingOps;
			if (sameOps(before, after)) return;
			undoPush({
				description: `${label} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`,
				undo: () => setOps(before),
				redo: () => setOps(after),
			});
		});
	}

	return (
		<div>
			<div className="flex items-center justify-between text-xs">
				<span className="text-base-content/75">{label}</span>
				<EditableValue
					value={currentValue}
					min={min}
					max={max}
					step={step}
					display={
						<>
							{currentValue.toFixed(step < 1 ? 2 : 0)}
							{unit ?? ""}
						</>
					}
					onCommit={commitTyped}
				/>
			</div>
			<input
				type="range"
				className="range range-xs range-primary"
				min={min}
				max={max}
				step={step}
				value={currentValue}
				title="Ctrl+click to reset"
				onPointerDown={(e) => {
					// Ctrl/Cmd+click resets to default without first jumping
					// the slider to the click position.
					if (e.ctrlKey || e.metaKey) {
						e.preventDefault();
						e.stopPropagation();
						resetToDefault();
						return;
					}
					beforeOpsRef.current = useEditorStore.getState().pendingOps;
				}}
				onChange={(e) => {
					const v = Number(e.target.value);
					void pushOp(makeOp(v), { replaceLastOfType: true });
				}}
				onPointerUp={() => {
					const before = beforeOpsRef.current;
					const after = useEditorStore.getState().pendingOps;
					beforeOpsRef.current = null;
					if (!before) return;
					if (sameOps(before, after)) return;
					undoPush({
						description: `${label} ${currentValue >= 0 ? "+" : ""}${currentValue.toFixed(2)}`,
						undo: () => setOps(before),
						redo: () => setOps(after),
					});
				}}
			/>
		</div>
	);
}

function CurveTool() {
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const pushOp = useEditorStore((s) => s.pushOp);
	const setOps = useEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);

	// Recover the current control points from the last luminance_curve op
	// in the pipeline, falling back to identity. We stash points alongside
	// the LUT in a ref so the editor can rehydrate after undo/redo without
	// having to round-trip through a LUT-to-points solver.
	const pointsRef = useRef<CurvePoint[]>([
		{ x: 0, y: 0 },
		{ x: 1, y: 1 },
	]);

	const hasCurveOp = useMemo(
		() => pendingOps.some((o) => o.type === "luminance_curve"),
		[pendingOps],
	);

	const beforeOpsRef = useRef<Operation[] | null>(null);
	// True while a curve gesture is in progress, so the remount effect below
	// can tell "the curve op just appeared because the user started dragging
	// from identity" (don't remount — it would drop pointer capture and kill
	// the drag) apart from "the curve appeared via undo/redo" (do remount).
	const draggingRef = useRef(false);

	// The editor keeps its control points in internal state, so we remount it
	// (via `key`) to re-sync with the pipeline when the curve's presence
	// changes for a reason *other* than the user starting a drag — i.e. the
	// Reset button, or undo/redo crossing the curve. Keying on op-presence
	// directly used to flip the key on the first drag tick (when the op first
	// lands), remounting mid-gesture and freezing the curve after one move.
	const [curveNonce, setCurveNonce] = useState(0);
	const prevHasCurveRef = useRef(hasCurveOp);
	useEffect(() => {
		if (hasCurveOp !== prevHasCurveRef.current) {
			if (!(hasCurveOp && draggingRef.current)) {
				setCurveNonce((n) => n + 1);
			}
			prevHasCurveRef.current = hasCurveOp;
		}
	}, [hasCurveOp]);

	function handleLive(points: CurvePoint[], lut: number[]) {
		// First live tick of a gesture: snapshot the pre-edit op list so the
		// commit handler can emit a single before→after undo entry, and mark
		// the gesture active so the remount effect leaves us mounted.
		if (beforeOpsRef.current === null) {
			beforeOpsRef.current = useEditorStore.getState().pendingOps;
			draggingRef.current = true;
		}
		pointsRef.current = points;
		void pushOp({ type: "luminance_curve", lut }, { replaceLastOfType: true });
	}

	function handleCommit(points: CurvePoint[], lut: number[]) {
		const before = beforeOpsRef.current;
		beforeOpsRef.current = null;
		draggingRef.current = false;
		// Double-click add/remove fires commit without a prior live tick; in
		// that case treat the current pendingOps as the before state.
		const snapshot = before ?? useEditorStore.getState().pendingOps;
		pointsRef.current = points;
		void pushOp({ type: "luminance_curve", lut }, { replaceLastOfType: true });
		queueMicrotask(() => {
			const after = useEditorStore.getState().pendingOps;
			if (sameOps(snapshot, after)) return;
			undoPush({
				description: "Luminance curve",
				undo: () => setOps(snapshot),
				redo: () => setOps(after),
			});
		});
	}

	function handleReset() {
		const next = pendingOps.filter((o) => o.type !== "luminance_curve");
		const before = pendingOps;
		pointsRef.current = [
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
		];
		void setOps(next);
		undoPush({
			description: "Reset curve",
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	const initialPoints = hasCurveOp
		? pointsRef.current
		: [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			];

	return (
		<div className="flex flex-col gap-2">
			<CurveEditor
				key={curveNonce}
				points={initialPoints}
				width={224}
				height={180}
				onChangeLive={handleLive}
				onChangeCommit={handleCommit}
			/>
			<div className="flex items-center justify-between text-[10px] text-base-content/45">
				<span>Drag to bend · double-click to add / remove</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs h-5 min-h-0 px-1.5"
					onClick={handleReset}
					disabled={!hasCurveOp}
				>
					Reset
				</button>
			</div>
		</div>
	);
}

/** Aspect-ratio presets. Click → replaces any existing crop with the
 *  largest centered rect of that aspect that fits inside the source
 *  ("smallest crop necessary" to reach the ratio). */
const CROP_PRESETS: { label: string; ratio: number }[] = [
	{ label: "1:1", ratio: 1 },
	{ label: "4:3", ratio: 4 / 3 },
	{ label: "3:2", ratio: 3 / 2 },
	{ label: "16:9", ratio: 16 / 9 },
	{ label: "9:16", ratio: 9 / 16 },
	{ label: "2:3", ratio: 2 / 3 },
];

function CropTool({
	sourceDims,
}: { sourceDims: { w: number; h: number } | null }) {
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const setOps = useEditorStore((s) => s.setOps);
	const setCropEditMode = useEditorStore((s) => s.setCropEditMode);
	const undoPush = useUndoStore((s) => s.push);

	const cropOp = pendingOps.find((o) => o.type === "crop") as
		| Extract<Operation, { type: "crop" }>
		| undefined;

	function clearCrop() {
		const before = pendingOps;
		const next = before.filter((o) => o.type !== "crop");
		if (sameOps(before, next)) return;
		void setOps(next);
		undoPush({
			description: "Clear crop",
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	function applyPreset(ratio: number) {
		if (!sourceDims) return;
		const rect = centeredCropForAspect(sourceDims.w, sourceDims.h, ratio);
		// Open the crop editor pre-loaded with the preset rect so the user
		// can review and tweak before committing.
		setCropEditMode(true, rect);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-[11px] text-base-content/55 font-mono">
				Original: {sourceDims ? formatAspect(sourceDims.w, sourceDims.h) : "…"}
			</div>
			{cropOp && (
				<div className="text-[11px] text-base-content/55 font-mono">
					{cropOp.w} × {cropOp.h} @ {cropOp.x},{cropOp.y}
				</div>
			)}
			<button
				type="button"
				className="btn btn-xs btn-block"
				onClick={() => setCropEditMode(true)}
			>
				Edit crop
			</button>
			<div className="grid grid-cols-3 gap-1">
				{CROP_PRESETS.map((p) => (
					<button
						key={p.label}
						type="button"
						className="btn btn-xs btn-ghost font-mono"
						onClick={() => applyPreset(p.ratio)}
						disabled={!sourceDims}
						title={`Open crop editor at ${p.label}`}
					>
						{p.label}
					</button>
				))}
			</div>
			{cropOp && (
				<button
					type="button"
					className="btn btn-xs btn-ghost btn-block"
					onClick={clearCrop}
				>
					Clear crop
				</button>
			)}
		</div>
	);
}

/** Format an aspect ratio for display: clean a:b when w and h reduce to
 *  small integers (covers all the common photo sizes); otherwise express
 *  as one-decimal ratio:1. */
function formatAspect(w: number, h: number): string {
	if (w <= 0 || h <= 0) return "—";
	const g = gcd(w, h);
	const aw = w / g;
	const ah = h / g;
	if (aw <= 32 && ah <= 32) return `${aw}:${ah}`;
	const r = w / h;
	return r >= 1 ? `${r.toFixed(1)}:1` : `1:${(1 / r).toFixed(1)}`;
}

function gcd(a: number, b: number): number {
	while (b !== 0) {
		[a, b] = [b, a % b];
	}
	return a;
}

/** Largest rect with aspect `targetRatio` (= w/h) that fits inside the
 *  source, centered on the source's center. */
function centeredCropForAspect(
	srcW: number,
	srcH: number,
	targetRatio: number,
): { x: number; y: number; w: number; h: number } {
	const srcRatio = srcW / srcH;
	let w: number;
	let h: number;
	if (targetRatio >= srcRatio) {
		// Target wider than source — pin to source width.
		w = srcW;
		h = srcW / targetRatio;
	} else {
		// Target narrower than source — pin to source height.
		h = srcH;
		w = srcH * targetRatio;
	}
	return {
		x: Math.max(0, Math.round((srcW - w) / 2)),
		y: Math.max(0, Math.round((srcH - h) / 2)),
		w: Math.max(1, Math.round(w)),
		h: Math.max(1, Math.round(h)),
	};
}

function ResizeTool({
	sourceDims,
}: { sourceDims: { w: number; h: number } | null }) {
	const [w, setW] = useState(sourceDims?.w.toString() ?? "");
	const [h, setH] = useState(sourceDims?.h.toString() ?? "");
	const [pct, setPct] = useState("100");
	const [mode, setMode] = useState<"px" | "pct">("pct");

	useEffect(() => {
		if (sourceDims) {
			setW(sourceDims.w.toString());
			setH(sourceDims.h.toString());
		}
	}, [sourceDims]);

	function apply() {
		let targetW: number;
		let targetH: number;
		if (mode === "pct" && sourceDims) {
			const p = Math.max(0.01, Number(pct) / 100);
			targetW = Math.max(1, Math.round(sourceDims.w * p));
			targetH = Math.max(1, Math.round(sourceDims.h * p));
		} else {
			targetW = Math.max(1, Math.floor(Number(w) || 1));
			targetH = Math.max(1, Math.floor(Number(h) || 1));
		}
		// One resize at a time — replace any existing resize op.
		const before = useEditorStore.getState().pendingOps;
		const op: Operation = { type: "resize", w: targetW, h: targetH };
		const next: Operation[] = [
			...before.filter((o) => o.type !== "resize"),
			op,
		];
		void useEditorStore.getState().setOps(next);
		useUndoStore.getState().push({
			description: `Resize → ${targetW}×${targetH}`,
			undo: () => useEditorStore.getState().setOps(before),
			redo: () => useEditorStore.getState().setOps(next),
		});
	}

	return (
		<>
			<div className="text-[11px] text-base-content/55 font-mono">
				Original: {sourceDims ? `${sourceDims.w} × ${sourceDims.h} px` : "…"}
			</div>
			<div className="join w-full">
				<button
					type="button"
					className={`btn btn-xs join-item flex-1 ${mode === "pct" ? "btn-primary" : ""}`}
					onClick={() => setMode("pct")}
				>
					Percent
				</button>
				<button
					type="button"
					className={`btn btn-xs join-item flex-1 ${mode === "px" ? "btn-primary" : ""}`}
					onClick={() => setMode("px")}
				>
					Pixels
				</button>
			</div>
			{mode === "px" ? (
				<div className="grid grid-cols-2 gap-1.5">
					<NumberField label="W" value={w} onChange={setW} />
					<NumberField label="H" value={h} onChange={setH} />
				</div>
			) : (
				<NumberField label="%" value={pct} onChange={setPct} />
			)}
			<button
				type="button"
				className="btn btn-xs btn-block mt-1"
				onClick={apply}
			>
				Apply resize
			</button>
		</>
	);
}

function RotateTool() {
	const [angle, setAngle] = useState("0");

	function rotateBy(deg: number) {
		// Fold incremental rotations into a single rotate op so the pipeline
		// stays compact and the preview's CSS transform composes cleanly.
		const before = useEditorStore.getState().pendingOps;
		const existing = before.find((o) => o.type === "rotate") as
			| Extract<Operation, { type: "rotate" }>
			| undefined;
		const summed = ((((existing?.angle ?? 0) + deg) % 360) + 360) % 360;
		const withoutRotate = before.filter((o) => o.type !== "rotate");
		const next: Operation[] =
			summed === 0
				? withoutRotate
				: [...withoutRotate, { type: "rotate", angle: summed }];
		void useEditorStore.getState().setOps(next);
		useUndoStore.getState().push({
			description: `Rotate ${deg > 0 ? "+" : ""}${deg}°`,
			undo: () => useEditorStore.getState().setOps(before),
			redo: () => useEditorStore.getState().setOps(next),
		});
	}

	function applyArbitrary() {
		const a = Number(angle) || 0;
		rotateBy(a);
	}

	return (
		<>
			<div className="join w-full">
				<button
					type="button"
					className="btn btn-xs join-item flex-1"
					onClick={() => rotateBy(-90)}
					title="Rotate counter-clockwise 90°"
				>
					<HiArrowUturnLeft className="size-3.5" />
					90°
				</button>
				<button
					type="button"
					className="btn btn-xs join-item flex-1"
					onClick={() => rotateBy(90)}
					title="Rotate clockwise 90°"
				>
					90°
					<HiArrowUturnRight className="size-3.5" />
				</button>
				<button
					type="button"
					className="btn btn-xs join-item flex-1"
					onClick={() => rotateBy(180)}
					title="Rotate 180°"
				>
					180°
				</button>
			</div>
			<div className="flex items-end gap-1.5">
				<NumberField label="Custom°" value={angle} onChange={setAngle} />
				<button type="button" className="btn btn-xs" onClick={applyArbitrary}>
					Apply
				</button>
			</div>
		</>
	);
}

function CornerRoundTool({
	sourceDims,
}: { sourceDims: { w: number; h: number } | null }) {
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const pushOp = useEditorStore((s) => s.pushOp);
	const setOps = useEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);
	const maxR = sourceDims
		? Math.floor(Math.min(sourceDims.w, sourceDims.h) / 2)
		: 256;

	const currentRadius = (() => {
		for (let i = pendingOps.length - 1; i >= 0; i--) {
			if (pendingOps[i].type === "corner_round") {
				return (pendingOps[i] as Extract<Operation, { type: "corner_round" }>)
					.radius;
			}
		}
		return 0;
	})();

	const beforeOpsRef = useRef<Operation[] | null>(null);

	function resetToDefault() {
		const before = useEditorStore.getState().pendingOps;
		const next = before.filter((o) => o.type !== "corner_round");
		if (sameOps(before, next)) return;
		void setOps(next);
		undoPush({
			description: "Reset corner round",
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	function commitTyped(v: number) {
		const clamped = Math.max(0, Math.min(maxR, Math.floor(v)));
		const before = useEditorStore.getState().pendingOps;
		void pushOp(
			{ type: "corner_round", radius: clamped },
			{ replaceLastOfType: true },
		);
		queueMicrotask(() => {
			const after = useEditorStore.getState().pendingOps;
			if (sameOps(before, after)) return;
			undoPush({
				description: `Corner round ${clamped} px`,
				undo: () => setOps(before),
				redo: () => setOps(after),
			});
		});
	}

	return (
		<div>
			<div className="flex items-center justify-between text-xs">
				<span className="text-base-content/75">Radius</span>
				<EditableValue
					value={currentRadius}
					min={0}
					max={maxR}
					step={1}
					display={`${currentRadius} px`}
					onCommit={commitTyped}
				/>
			</div>
			<input
				type="range"
				className="range range-xs range-primary"
				min={0}
				max={maxR}
				step={1}
				value={currentRadius}
				title="Ctrl+click to reset"
				onPointerDown={(e) => {
					if (e.ctrlKey || e.metaKey) {
						e.preventDefault();
						e.stopPropagation();
						resetToDefault();
						return;
					}
					beforeOpsRef.current = useEditorStore.getState().pendingOps;
				}}
				onChange={(e) => {
					const v = Math.max(0, Math.floor(Number(e.target.value)));
					void pushOp(
						{ type: "corner_round", radius: v },
						{ replaceLastOfType: true },
					);
				}}
				onPointerUp={() => {
					const before = beforeOpsRef.current;
					const after = useEditorStore.getState().pendingOps;
					beforeOpsRef.current = null;
					if (!before) return;
					if (sameOps(before, after)) return;
					undoPush({
						description: `Corner round ${currentRadius} px`,
						undo: () => setOps(before),
						redo: () => setOps(after),
					});
				}}
			/>
		</div>
	);
}

function NumberField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<label className="flex flex-col gap-0.5">
			<span className="text-[10px] uppercase tracking-wider text-base-content/55">
				{label}
			</span>
			<input
				type="number"
				className="input input-xs input-bordered w-full font-mono text-[11px]"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</label>
	);
}

/// Apply a single op and push a paired undo entry. Used for click-style
/// tools where each commit is its own undo step.
function pushWithUndo(op: Operation, description: string) {
	const before = useEditorStore.getState().pendingOps;
	void useEditorStore
		.getState()
		.pushOp(op)
		.then(() => {
			const after = useEditorStore.getState().pendingOps;
			useUndoStore.getState().push({
				description,
				undo: () => useEditorStore.getState().setOps(before),
				redo: () => useEditorStore.getState().setOps(after),
			});
		});
}

function sameOps(a: Operation[], b: Operation[]) {
	return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

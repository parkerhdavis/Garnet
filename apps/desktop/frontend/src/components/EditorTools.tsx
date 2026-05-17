// SPDX-License-Identifier: AGPL-3.0-or-later
//! Right-hand tools panel for the image editor: adjust sliders (hue,
//! saturation, brightness, contrast) and transform tools (crop, resize,
//! rotate, corner-round). Slider drags coalesce into a single op via
//! `replaceLastOfType` and push one combined undo entry on pointer-up;
//! click-style tools (rotate buttons, Apply) push one op + one undo entry.

import { useEffect, useRef, useState } from "react";
import {
	HiArrowPath,
	HiArrowUturnLeft,
	HiArrowUturnRight,
	HiScissors,
	HiSparkles,
	HiSquare2Stack,
	HiSwatch,
} from "react-icons/hi2";
import { type Operation, useEditorStore } from "@/stores/editorStore";
import { useUndoStore } from "@/stores/undoStore";

/// Hide the transform tools until their backend preview path is sorted.
/// Backend `editor::transform` + commands are intact and unit-tested;
/// flip this back on once the frontend integration is debugged. See
/// `40-69 Projects/41 PhD - Software/Garnet/90-99 Agents/Transient/
/// editor-transform-tools-todo.md` for resume notes.
const TRANSFORM_TOOLS_ENABLED = false;

export function EditorTools({ sourceDims }: { sourceDims: { w: number; h: number } | null }) {
	return (
		<aside className="w-72 shrink-0 border-l border-base-300 bg-base-100 overflow-y-auto">
			<Section
				title="Adjust"
				icon={<HiSwatch className="size-3.5" />}
				last={!TRANSFORM_TOOLS_ENABLED}
			>
				<AdjustSlider type="adjust_hue" label="Hue" min={-180} max={180} step={1} unit="°" />
				<AdjustSlider type="adjust_saturation" label="Saturation" min={-1} max={1} step={0.01} />
				<AdjustSlider type="adjust_brightness" label="Brightness" min={-1} max={1} step={0.01} />
				<AdjustSlider type="adjust_contrast" label="Contrast" min={-1} max={1} step={0.01} />
			</Section>

			{TRANSFORM_TOOLS_ENABLED && (
				<>
					<Section title="Crop" icon={<HiScissors className="size-3.5" />}>
						<CropTool sourceDims={sourceDims} />
					</Section>

					<Section title="Resize" icon={<HiSquare2Stack className="size-3.5" />}>
						<ResizeTool sourceDims={sourceDims} />
					</Section>

					<Section title="Rotate" icon={<HiArrowPath className="size-3.5" />}>
						<RotateTool />
					</Section>

					<Section title="Corner round" icon={<HiSparkles className="size-3.5" />} last>
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

/** Wraps a numeric slider for an "adjust_*" op so the slider drag coalesces
 *  into one op and one undo entry. */
function AdjustSlider({
	type,
	label,
	min,
	max,
	step,
	unit,
}: {
	type: "adjust_hue" | "adjust_saturation" | "adjust_brightness" | "adjust_contrast";
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

	const currentValue = (() => {
		for (let i = pendingOps.length - 1; i >= 0; i--) {
			const op = pendingOps[i];
			if (op.type === type) {
				return type === "adjust_contrast"
					? (op as Extract<Operation, { type: "adjust_contrast" }>).amount
					: (op as Extract<Operation, { type: typeof type; offset: number }>).offset;
			}
		}
		return 0;
	})();

	const beforeOpsRef = useRef<Operation[] | null>(null);

	function makeOp(value: number): Operation {
		if (type === "adjust_contrast") return { type, amount: value };
		return { type, offset: value };
	}

	return (
		<div>
			<div className="flex items-center justify-between text-xs">
				<span className="text-base-content/75">{label}</span>
				<span className="font-mono text-[11px] text-base-content/60">
					{currentValue.toFixed(step < 1 ? 2 : 0)}
					{unit ?? ""}
				</span>
			</div>
			<input
				type="range"
				className="range range-xs range-primary"
				min={min}
				max={max}
				step={step}
				value={currentValue}
				onPointerDown={() => {
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

function CropTool({ sourceDims }: { sourceDims: { w: number; h: number } | null }) {
	const [x, setX] = useState("0");
	const [y, setY] = useState("0");
	const [w, setW] = useState(sourceDims?.w.toString() ?? "");
	const [h, setH] = useState(sourceDims?.h.toString() ?? "");

	useEffect(() => {
		if (sourceDims) {
			setW(sourceDims.w.toString());
			setH(sourceDims.h.toString());
		}
	}, [sourceDims]);

	function apply() {
		const op: Operation = {
			type: "crop",
			x: Math.max(0, Math.floor(Number(x) || 0)),
			y: Math.max(0, Math.floor(Number(y) || 0)),
			w: Math.max(1, Math.floor(Number(w) || 1)),
			h: Math.max(1, Math.floor(Number(h) || 1)),
		};
		pushWithUndo(op, `Crop ${op.w}×${op.h} @ ${op.x},${op.y}`);
	}

	return (
		<>
			<div className="grid grid-cols-2 gap-1.5">
				<NumberField label="X" value={x} onChange={setX} />
				<NumberField label="Y" value={y} onChange={setY} />
				<NumberField label="W" value={w} onChange={setW} />
				<NumberField label="H" value={h} onChange={setH} />
			</div>
			<button type="button" className="btn btn-xs btn-block mt-1" onClick={apply}>
				Apply crop
			</button>
		</>
	);
}

function ResizeTool({ sourceDims }: { sourceDims: { w: number; h: number } | null }) {
	const [w, setW] = useState(sourceDims?.w.toString() ?? "");
	const [h, setH] = useState(sourceDims?.h.toString() ?? "");
	const [pct, setPct] = useState("100");
	const [mode, setMode] = useState<"px" | "pct">("px");

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
		const op: Operation = { type: "resize", w: targetW, h: targetH };
		pushWithUndo(op, `Resize → ${targetW}×${targetH}`);
	}

	return (
		<>
			<div className="join w-full">
				<button
					type="button"
					className={`btn btn-xs join-item flex-1 ${mode === "px" ? "btn-active" : ""}`}
					onClick={() => setMode("px")}
				>
					Pixels
				</button>
				<button
					type="button"
					className={`btn btn-xs join-item flex-1 ${mode === "pct" ? "btn-active" : ""}`}
					onClick={() => setMode("pct")}
				>
					Percent
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
			<button type="button" className="btn btn-xs btn-block mt-1" onClick={apply}>
				Apply resize
			</button>
		</>
	);
}

function RotateTool() {
	const [angle, setAngle] = useState("0");

	function rotateBy(deg: number) {
		const op: Operation = { type: "rotate", angle: deg };
		pushWithUndo(op, `Rotate ${deg > 0 ? "+" : ""}${deg}°`);
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

function CornerRoundTool({ sourceDims }: { sourceDims: { w: number; h: number } | null }) {
	const pendingOps = useEditorStore((s) => s.pendingOps);
	const pushOp = useEditorStore((s) => s.pushOp);
	const setOps = useEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);
	const maxR = sourceDims ? Math.floor(Math.min(sourceDims.w, sourceDims.h) / 2) : 256;

	const currentRadius = (() => {
		for (let i = pendingOps.length - 1; i >= 0; i--) {
			if (pendingOps[i].type === "corner_round") {
				return (pendingOps[i] as Extract<Operation, { type: "corner_round" }>).radius;
			}
		}
		return 0;
	})();

	const beforeOpsRef = useRef<Operation[] | null>(null);

	return (
		<div>
			<div className="flex items-center justify-between text-xs">
				<span className="text-base-content/75">Radius</span>
				<span className="font-mono text-[11px] text-base-content/60">{currentRadius} px</span>
			</div>
			<input
				type="range"
				className="range range-xs range-primary"
				min={0}
				max={maxR}
				step={1}
				value={currentRadius}
				onPointerDown={() => {
					beforeOpsRef.current = useEditorStore.getState().pendingOps;
				}}
				onChange={(e) => {
					const v = Math.max(0, Math.floor(Number(e.target.value)));
					void pushOp({ type: "corner_round", radius: v }, { replaceLastOfType: true });
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
			<span className="text-[10px] uppercase tracking-wider text-base-content/55">{label}</span>
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

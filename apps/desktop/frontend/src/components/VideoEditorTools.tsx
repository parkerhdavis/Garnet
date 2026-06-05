// SPDX-License-Identifier: AGPL-3.0-or-later
//! Right-hand tools panel for the video editor — the video counterpart of
//! `EditorTools`. Sections: Trim (in/out + set-to-playhead), Adjustments
//! (brightness / contrast / saturation / hue), Crop, Resize, Rotate. Each
//! tool replaces its own op in the pending list and pushes one paired undo
//! entry, mirroring the image editor's coalescing model.
//!
//! Color adjustments map to ffmpeg `eq`/`hue` on commit; the on-canvas preview
//! approximates them with a CSS filter (same approximate-preview/exact-commit
//! split the image editor documents).

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	HiArrowPath,
	HiArrowUturnLeft,
	HiArrowUturnRight,
	HiScissors,
	HiSquare2Stack,
	HiSwatch,
	HiVideoCamera,
} from "react-icons/hi2";
import {
	readTrim,
	useVideoEditorStore,
	type VideoOperation,
	withTrim,
} from "@/stores/videoEditorStore";
import { useUndoStore } from "@/stores/undoStore";

export function VideoEditorTools() {
	const info = useVideoEditorStore((s) => s.info);
	const sourceDims = info ? { w: info.width, h: info.height } : null;
	return (
		<aside className="w-72 shrink-0 border-l border-base-300 bg-base-100 overflow-y-auto">
			<Section title="Trim" icon={<HiVideoCamera className="size-3.5" />}>
				<TrimTool />
			</Section>

			<Section title="Adjustments" icon={<HiSwatch className="size-3.5" />}>
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
					type="adjust_saturation"
					label="Saturation"
					min={-1}
					max={1}
					step={0.01}
				/>
				<AdjustSlider
					type="adjust_hue"
					label="Hue"
					min={-180}
					max={180}
					step={1}
					unit="°"
				/>
			</Section>

			<Section title="Crop" icon={<HiScissors className="size-3.5" />}>
				<CropTool sourceDims={sourceDims} />
			</Section>

			<Section title="Resize" icon={<HiSquare2Stack className="size-3.5" />}>
				<ResizeTool sourceDims={sourceDims} />
			</Section>

			<Section title="Rotate" icon={<HiArrowPath className="size-3.5" />} last>
				<RotateTool />
			</Section>
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
	icon?: ReactNode;
	children: ReactNode;
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

// --------------------------------------------------------------------------
// Trim
// --------------------------------------------------------------------------

function TrimTool() {
	const info = useVideoEditorStore((s) => s.info);
	const pendingOps = useVideoEditorStore((s) => s.pendingOps);
	const playheadSecs = useVideoEditorStore((s) => s.playheadSecs);
	const setOps = useVideoEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);

	const duration = info?.duration_secs ?? 0;
	const trim = readTrim(pendingOps, duration);
	const trimmed = pendingOps.some((o) => o.type === "trim");

	function applyTrim(start: number, end: number, label: string) {
		const s = Math.max(0, Math.min(start, duration));
		const e = Math.max(s + 0.05, Math.min(end, duration));
		const before = useVideoEditorStore.getState().pendingOps;
		const next = withTrim(before, { start: s, end: e }, duration);
		if (sameOps(before, next)) return;
		setOps(next);
		undoPush({
			description: label,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	function clearTrim() {
		const before = useVideoEditorStore.getState().pendingOps;
		const next = before.filter((o) => o.type !== "trim");
		if (sameOps(before, next)) return;
		setOps(next);
		undoPush({
			description: "Clear trim",
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="grid grid-cols-2 gap-1.5">
				<button
					type="button"
					className="btn btn-xs"
					onClick={() => applyTrim(playheadSecs, trim.end, "Set trim in")}
					title="Set the trim in-point to the current playhead"
				>
					Set in
				</button>
				<button
					type="button"
					className="btn btn-xs"
					onClick={() => applyTrim(trim.start, playheadSecs, "Set trim out")}
					title="Set the trim out-point to the current playhead"
				>
					Set out
				</button>
			</div>
			<div className="grid grid-cols-2 gap-1.5">
				<TimeField
					label="In (s)"
					value={trim.start}
					onCommit={(v) => applyTrim(v, trim.end, "Set trim in")}
				/>
				<TimeField
					label="Out (s)"
					value={trim.end}
					onCommit={(v) => applyTrim(trim.start, v, "Set trim out")}
				/>
			</div>
			{trimmed && (
				<button
					type="button"
					className="btn btn-xs btn-ghost btn-block"
					onClick={clearTrim}
				>
					Clear trim
				</button>
			)}
		</div>
	);
}

function TimeField({
	label,
	value,
	onCommit,
}: {
	label: string;
	value: number;
	onCommit: (v: number) => void;
}) {
	const [text, setText] = useState(value.toFixed(2));
	useEffect(() => setText(value.toFixed(2)), [value]);
	return (
		<label className="flex flex-col gap-0.5">
			<span className="text-[10px] uppercase tracking-wider text-base-content/55">
				{label}
			</span>
			<input
				type="number"
				step={0.1}
				min={0}
				className="input input-xs input-bordered w-full font-mono text-[11px]"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onBlur={() => {
					const v = Number(text);
					if (Number.isFinite(v)) onCommit(v);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				}}
			/>
		</label>
	);
}

// --------------------------------------------------------------------------
// Adjustments
// --------------------------------------------------------------------------

type AdjustType =
	| "adjust_brightness"
	| "adjust_contrast"
	| "adjust_saturation"
	| "adjust_hue";

// Contrast carries its value as `amount`; the rest use `offset`.
const AMOUNT_OPS = new Set<AdjustType>(["adjust_contrast"]);

function AdjustSlider({
	type,
	label,
	min,
	max,
	step,
	unit,
}: {
	type: AdjustType;
	label: string;
	min: number;
	max: number;
	step: number;
	unit?: string;
}) {
	const pendingOps = useVideoEditorStore((s) => s.pendingOps);
	const setOps = useVideoEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);
	const isAmount = AMOUNT_OPS.has(type);
	const beforeRef = useRef<VideoOperation[] | null>(null);

	const currentValue = (() => {
		for (let i = pendingOps.length - 1; i >= 0; i--) {
			const op = pendingOps[i];
			if (op.type === type) {
				// biome-ignore lint/suspicious/noExplicitAny: narrowed by op.type === type
				return isAmount ? (op as any).amount : (op as any).offset;
			}
		}
		return 0;
	})();

	function makeOp(value: number): VideoOperation {
		return (
			isAmount ? { type, amount: value } : { type, offset: value }
		) as VideoOperation;
	}

	function setValue(value: number) {
		const before = useVideoEditorStore.getState().pendingOps;
		const rest = before.filter((o) => o.type !== type);
		const next = value === 0 ? rest : [...rest, makeOp(value)];
		setOps(next);
	}

	function resetToDefault() {
		const before = useVideoEditorStore.getState().pendingOps;
		const next = before.filter((o) => o.type !== type);
		if (sameOps(before, next)) return;
		setOps(next);
		undoPush({
			description: `Reset ${label}`,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
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
				title="Ctrl+click to reset"
				onPointerDown={(e) => {
					if (e.ctrlKey || e.metaKey) {
						e.preventDefault();
						e.stopPropagation();
						resetToDefault();
						return;
					}
					beforeRef.current = useVideoEditorStore.getState().pendingOps;
				}}
				onChange={(e) => setValue(Number(e.target.value))}
				onPointerUp={() => {
					const before = beforeRef.current;
					beforeRef.current = null;
					const after = useVideoEditorStore.getState().pendingOps;
					if (!before || sameOps(before, after)) return;
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

// --------------------------------------------------------------------------
// Crop
// --------------------------------------------------------------------------

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
	const pendingOps = useVideoEditorStore((s) => s.pendingOps);
	const setOps = useVideoEditorStore((s) => s.setOps);
	const setCropEditMode = useVideoEditorStore((s) => s.setCropEditMode);
	const undoPush = useUndoStore((s) => s.push);

	const cropOp = pendingOps.find((o) => o.type === "crop") as
		| Extract<VideoOperation, { type: "crop" }>
		| undefined;

	function clearCrop() {
		const before = pendingOps;
		const next = before.filter((o) => o.type !== "crop");
		if (sameOps(before, next)) return;
		setOps(next);
		undoPush({
			description: "Clear crop",
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	function applyPreset(ratio: number) {
		if (!sourceDims) return;
		setCropEditMode(
			true,
			centeredCropForAspect(sourceDims.w, sourceDims.h, ratio),
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-[11px] text-base-content/55 font-mono">
				Source: {sourceDims ? `${sourceDims.w} × ${sourceDims.h}` : "…"}
			</div>
			{cropOp && (
				<div className="text-[11px] text-base-content/55 font-mono">
					{cropOp.w} × {cropOp.h} @ {cropOp.x},{cropOp.y}
				</div>
			)}
			<button
				type="button"
				className="btn btn-xs btn-block"
				disabled={!sourceDims}
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

// --------------------------------------------------------------------------
// Resize
// --------------------------------------------------------------------------

function ResizeTool({
	sourceDims,
}: { sourceDims: { w: number; h: number } | null }) {
	const [w, setW] = useState("");
	const [h, setH] = useState("");
	const [pct, setPct] = useState("100");
	const [mode, setMode] = useState<"px" | "pct">("pct");
	const setOps = useVideoEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);

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
		const before = useVideoEditorStore.getState().pendingOps;
		const next: VideoOperation[] = [
			...before.filter((o) => o.type !== "resize"),
			{ type: "resize", w: targetW, h: targetH },
		];
		setOps(next);
		undoPush({
			description: `Resize → ${targetW}×${targetH}`,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	return (
		<>
			<div className="text-[11px] text-base-content/55 font-mono">
				Source: {sourceDims ? `${sourceDims.w} × ${sourceDims.h} px` : "…"}
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

// --------------------------------------------------------------------------
// Rotate (90° increments only — video transpose is lossless and the backend
// rejects non-90° angles).
// --------------------------------------------------------------------------

function RotateTool() {
	const setOps = useVideoEditorStore((s) => s.setOps);
	const undoPush = useUndoStore((s) => s.push);

	function rotateBy(deg: number) {
		const before = useVideoEditorStore.getState().pendingOps;
		const existing = before.find((o) => o.type === "rotate") as
			| Extract<VideoOperation, { type: "rotate" }>
			| undefined;
		const summed = ((((existing?.angle ?? 0) + deg) % 360) + 360) % 360;
		const withoutRotate = before.filter((o) => o.type !== "rotate");
		const next: VideoOperation[] =
			summed === 0
				? withoutRotate
				: [...withoutRotate, { type: "rotate", angle: summed }];
		setOps(next);
		undoPush({
			description: `Rotate ${deg > 0 ? "+" : ""}${deg}°`,
			undo: () => setOps(before),
			redo: () => setOps(next),
		});
	}

	return (
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

/// Largest rect with aspect `targetRatio` (= w/h) that fits inside the source,
/// centered. Same math as the image editor's crop presets.
function centeredCropForAspect(
	srcW: number,
	srcH: number,
	targetRatio: number,
): { x: number; y: number; w: number; h: number } {
	const srcRatio = srcW / srcH;
	let w: number;
	let h: number;
	if (targetRatio >= srcRatio) {
		w = srcW;
		h = srcW / targetRatio;
	} else {
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

function sameOps(a: VideoOperation[], b: VideoOperation[]): boolean {
	return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

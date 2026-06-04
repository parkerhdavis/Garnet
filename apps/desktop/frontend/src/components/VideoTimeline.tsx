// SPDX-License-Identifier: AGPL-3.0-or-later
//! Scrub timeline for the video editor: a horizontal track with a draggable
//! playhead plus two trim handles (in / out). The region outside [in, out] is
//! dimmed so the kept span reads at a glance. All positions are in seconds;
//! the component maps to/from pixels off its own measured width.
//!
//! There is no play button — the canvas shows a frame extracted at the
//! playhead rather than an inline `<video>` (webkit2gtk's media element is
//! unreliable on Linux). Scrubbing the playhead re-extracts the frame.

import { useCallback, useRef } from "react";

export interface TrimRange {
	start: number;
	end: number;
}

interface VideoTimelineProps {
	durationSecs: number;
	playheadSecs: number;
	trim: TrimRange;
	/// Move the playhead (the store debounces frame extraction).
	onSeek: (secs: number) => void;
	/// Commit a new trim range (the page records one undo entry per gesture).
	onTrimChange: (range: TrimRange) => void;
}

type Drag = "playhead" | "in" | "out" | null;

export function VideoTimeline({
	durationSecs,
	playheadSecs,
	trim,
	onSeek,
	onTrimChange,
}: VideoTimelineProps) {
	const trackRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<Drag>(null);

	const dur = durationSecs > 0 ? durationSecs : 1;
	const pct = (s: number) => `${Math.max(0, Math.min(1, s / dur)) * 100}%`;

	// Pointer x → seconds on the track.
	const secsAtClientX = useCallback(
		(clientX: number): number => {
			const el = trackRef.current;
			if (!el) return 0;
			const r = el.getBoundingClientRect();
			const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
			return Math.max(0, Math.min(dur, frac * dur));
		},
		[dur],
	);

	const onPointerMove = useCallback(
		(e: PointerEvent) => {
			const kind = dragRef.current;
			if (!kind) return;
			const s = secsAtClientX(e.clientX);
			if (kind === "playhead") {
				onSeek(s);
			} else if (kind === "in") {
				// Keep at least a frame's worth before the out point.
				onTrimChange({ start: Math.min(s, trim.end - 0.05), end: trim.end });
				onSeek(Math.min(s, trim.end - 0.05));
			} else {
				onTrimChange({
					start: trim.start,
					end: Math.max(s, trim.start + 0.05),
				});
				onSeek(Math.max(s, trim.start + 0.05));
			}
		},
		[secsAtClientX, onSeek, onTrimChange, trim.start, trim.end],
	);

	const endDrag = useCallback(() => {
		dragRef.current = null;
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", endDrag);
	}, [onPointerMove]);

	const startDrag = useCallback(
		(kind: Exclude<Drag, null>, e: React.PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			dragRef.current = kind;
			window.addEventListener("pointermove", onPointerMove);
			window.addEventListener("pointerup", endDrag);
		},
		[onPointerMove, endDrag],
	);

	// Click on the bare track jumps the playhead there.
	const onTrackPointerDown = (e: React.PointerEvent) => {
		onSeek(secsAtClientX(e.clientX));
		startDrag("playhead", e);
	};

	return (
		<div className="px-4 py-3 border-t border-base-300 bg-base-100 shrink-0 select-none">
			<div className="flex items-center justify-between text-[11px] font-mono text-base-content/55 mb-1.5">
				<span>{fmtTime(playheadSecs)}</span>
				<span>
					trim {fmtTime(trim.start)} – {fmtTime(trim.end)} (
					{fmtTime(Math.max(0, trim.end - trim.start))})
				</span>
				<span>{fmtTime(durationSecs)}</span>
			</div>

			<div
				ref={trackRef}
				className="relative h-9 rounded bg-base-300 cursor-pointer touch-none"
				onPointerDown={onTrackPointerDown}
			>
				{/* Dimmed regions outside the trim range. */}
				<div
					className="absolute inset-y-0 left-0 bg-base-100/70 rounded-l"
					style={{ width: pct(trim.start) }}
				/>
				<div
					className="absolute inset-y-0 right-0 bg-base-100/70 rounded-r"
					style={{ left: pct(trim.end) }}
				/>
				{/* Kept span tint. */}
				<div
					className="absolute inset-y-0 bg-primary/15"
					style={{
						left: pct(trim.start),
						right: `${100 - (trim.end / dur) * 100}%`,
					}}
				/>

				{/* In/out handles. */}
				<Handle
					posPct={pct(trim.start)}
					side="in"
					onDown={(e) => startDrag("in", e)}
				/>
				<Handle
					posPct={pct(trim.end)}
					side="out"
					onDown={(e) => startDrag("out", e)}
				/>

				{/* Playhead. */}
				<div
					className="absolute top-0 bottom-0 w-0.5 bg-primary pointer-events-none"
					style={{ left: pct(playheadSecs) }}
				>
					<div className="absolute -top-1 -left-[3px] size-2 rotate-45 bg-primary" />
				</div>
			</div>
		</div>
	);
}

function Handle({
	posPct,
	side,
	onDown,
}: {
	posPct: string;
	side: "in" | "out";
	onDown: (e: React.PointerEvent) => void;
}) {
	return (
		<div
			role="slider"
			aria-label={side === "in" ? "Trim start" : "Trim end"}
			aria-valuetext={side}
			tabIndex={0}
			className="absolute top-0 bottom-0 w-2 -ml-1 bg-primary/80 hover:bg-primary cursor-ew-resize rounded-sm"
			style={{ left: posPct }}
			onPointerDown={onDown}
		/>
	);
}

/// `m:ss.s` (or `h:mm:ss.s` past an hour). Compact but frame-ish precise.
function fmtTime(secs: number): string {
	if (!Number.isFinite(secs) || secs < 0) secs = 0;
	const h = Math.floor(secs / 3600);
	const m = Math.floor((secs % 3600) / 60);
	const s = secs % 60;
	const sStr = s.toFixed(1).padStart(4, "0");
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${sStr}`;
	return `${m}:${sStr}`;
}

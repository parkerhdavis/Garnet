// SPDX-License-Identifier: AGPL-3.0-or-later
//! Peaks-only waveform (wavesurfer.js, lazily loaded). Pure visualization +
//! click-to-seek: it renders pre-computed peaks and never decodes audio (the
//! native Rust engine owns playback). The cursor is driven by the parent's
//! `position`; clicks bubble up through `onSeek`.

import { useEffect, useRef, useState } from "react";
import {
	loadWavesurfer,
	type WaveSurferInstance,
} from "@/plugins/music/lib/loadWavesurfer";

/// Read a daisyUI theme color (oklch CSS var) with an rgb fallback.
function themeColor(el: HTMLElement, varName: string, fallback: string): string {
	const v = getComputedStyle(el).getPropertyValue(varName).trim();
	return v || fallback;
}

export function Waveform({
	peaks,
	duration,
	position,
	height = 40,
	onSeek,
}: {
	peaks: number[];
	duration: number;
	position: number;
	height?: number;
	onSeek?: (seconds: number) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const wsRef = useRef<WaveSurferInstance | null>(null);
	const [ready, setReady] = useState(false);

	// Pin the latest onSeek so we don't rebuild wavesurfer on a new closure.
	const onSeekRef = useRef(onSeek);
	useEffect(() => {
		onSeekRef.current = onSeek;
	});

	// Build once per (peaks identity, duration, height). A new track replaces
	// the peaks array, which is the right cue to rebuild.
	useEffect(() => {
		const el = containerRef.current;
		if (!el || peaks.length === 0 || duration <= 0) return;
		let destroyed = false;
		let ws: WaveSurferInstance | null = null;
		setReady(false);

		void loadWavesurfer().then((WaveSurfer) => {
			if (destroyed || !containerRef.current) return;
			ws = WaveSurfer.create({
				container: containerRef.current,
				height,
				waveColor: "rgba(130,130,140,0.45)",
				progressColor: themeColor(el, "--color-primary", "#7c3aed"),
				cursorColor: themeColor(el, "--color-primary", "#7c3aed"),
				cursorWidth: 1,
				barWidth: 2,
				barGap: 1,
				barRadius: 2,
				normalize: true,
				interact: true,
				// Peaks-only mode: pass peaks + duration, no `url` — no decode.
				peaks: [peaks],
				duration,
			});
			wsRef.current = ws;
			ws.on("ready", () => setReady(true));
			ws.on("interaction", (seconds: number) => onSeekRef.current?.(seconds));
		});

		return () => {
			destroyed = true;
			try {
				ws?.destroy();
			} catch {
				// Pre-init / post-destroy race; nothing to clean up.
			}
			wsRef.current = null;
		};
	}, [peaks, duration, height]);

	// Sync the cursor to the parent-controlled position (cheapest update path).
	useEffect(() => {
		const ws = wsRef.current;
		if (!ws || !ready) return;
		try {
			ws.setTime(position);
		} catch {
			// Pre-init / post-destroy race; the next update lands cleanly.
		}
	}, [position, ready]);

	// Fade in once wavesurfer has rendered (peaks arrive a beat after play
	// starts), so the waveform eases in instead of popping.
	return (
		<div
			ref={containerRef}
			className={`w-full cursor-pointer transition-opacity duration-500 ${
				ready ? "opacity-100" : "opacity-0"
			}`}
		/>
	);
}

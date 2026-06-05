// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-video editor state — the video equivalent of `editorStore`.
//!
//! As with the image editor, edits are deferred: a list of `VideoOperation`s
//! lives here until the user commits via the save flow. Unlike the image
//! editor — whose canvas re-renders the original `<img>` with a CSS-filter
//! chain on every op — the video canvas shows a single **frame** extracted at
//! the playhead, and the spatial/color ops preview client-side over that frame
//! (CSS filters + `EditorCanvas` geometry). So an op change does NOT trigger a
//! backend round-trip; only moving the playhead does (it re-extracts a frame).
//! Trim in/out are markers on the timeline — they bound the export but don't
//! change the previewed frame.
//!
//! One global store (one editor open at a time, a dedicated route). Each user
//! action also pushes a paired `undoStore` entry from the tools, keeping
//! `pendingOps` and the undo history aligned without a second mechanism.

import { create } from "zustand";
import { api, mediaUrl, type VideoInfo } from "@/lib/tauri";

/// Mirrors the Rust `video_editor::VideoOperation` (snake_case serde tag).
export type VideoOperation =
	| { type: "trim"; start_secs: number; end_secs: number }
	| { type: "crop"; x: number; y: number; w: number; h: number }
	| { type: "resize"; w: number; h: number }
	| { type: "rotate"; angle: number }
	| { type: "adjust_brightness"; offset: number }
	| { type: "adjust_contrast"; amount: number }
	| { type: "adjust_saturation"; offset: number }
	| { type: "adjust_hue"; offset: number };

/// Preview frames are downscaled so scrubbing stays snappy; the commit always
/// runs at full resolution.
const PREVIEW_MAX_DIM = 960;
/// Playback frames are smaller still — frame-stepping playback wants speed over
/// crispness (each frame is a fresh ffmpeg seek+decode).
const PLAYBACK_MAX_DIM = 640;
/// Debounce for re-extracting a frame as the playhead moves — a scrub drag
/// fires many ticks, but one ffmpeg seek per ~90ms is plenty for a preview.
const SCRUB_DEBOUNCE_MS = 90;

interface VideoEditorState {
	/// Absolute path of the source video. null when nothing is loaded.
	sourcePath: string | null;
	/// Friendly name for the header / save-dialog default.
	sourceName: string | null;
	/// Probed source facts (duration, dims, fps, codec, audio). null until loaded.
	info: VideoInfo | null;
	/// Ordered pending operations — replayed by the backend on commit.
	pendingOps: VideoOperation[];
	/// Current playhead position in seconds (drives frame extraction).
	playheadSecs: number;
	/// HTTP URL of the currently displayed preview frame (served by the media
	/// server). null until the first frame lands.
	frameUrl: string | null;
	/// True while a frame extraction is in flight.
	extracting: boolean;
	/// True after any op lands; reset on load / save / reset.
	dirty: boolean;
	/// Surfaced load/extract error (e.g. ffmpeg missing).
	error: string | null;
	/// True while the user is interactively setting a crop rect — the canvas
	/// swaps to a draggable rect overlay over the current frame.
	cropEditMode: boolean;
	/// Optional rect to seed the crop editor with (e.g. an aspect preset);
	/// null falls back to the existing crop op, then the full frame.
	cropEditorInitial: CropRect | null;

	load: (path: string, name: string) => Promise<void>;
	reset: () => void;
	/// Replace the entire op list (tools build the next list themselves, then
	/// hand it here — same contract as the image editor's `setOps`).
	setOps: (ops: VideoOperation[]) => void;
	/// Move the playhead and (debounced) re-extract the frame at it.
	setPlayhead: (secs: number) => void;
	setCropEditMode: (b: boolean, initial?: CropRect | null) => void;
	/// True while frame-stepping playback is running.
	playing: boolean;
	/// Toggle playback. Plays within the trim range (looping at the out-point),
	/// advancing the playhead by wall-clock time and re-extracting frames. This
	/// is frame-stepping (no audio, capped by extraction speed) rather than an
	/// inline `<video>`, which is unreliable in Linux webkit2gtk.
	togglePlay: () => void;
}

export type CropRect = { x: number; y: number; w: number; h: number };
export type TrimRange = { start: number; end: number };

/// The effective trim window: the trim op if present, else the whole clip.
export function readTrim(ops: VideoOperation[], duration: number): TrimRange {
	const t = ops.find((o) => o.type === "trim");
	if (t && t.type === "trim") return { start: t.start_secs, end: t.end_secs };
	return { start: 0, end: duration };
}

/// Replace the trim op with `range`, or drop it entirely when the range covers
/// the whole clip (so the commit emits no `-ss`/`-t` and stays a pure copy of
/// the timeline). Tolerant of float fuzz at the ends.
export function withTrim(
	ops: VideoOperation[],
	range: TrimRange,
	duration: number,
): VideoOperation[] {
	const rest = ops.filter((o) => o.type !== "trim");
	const full = range.start <= 0.0001 && range.end >= duration - 0.0001;
	if (full) return rest;
	return [
		...rest,
		{ type: "trim", start_secs: range.start, end_secs: range.end },
	];
}

// Monotonic token so a slow/out-of-order frame extraction can't clobber a
// newer one (or a different video after a switch). Module-scoped, not in the
// store — no component subscribes to it.
let frameToken = 0;
let scrubTimer: ReturnType<typeof setTimeout> | null = null;
// Playback anchor: wall-clock ms and playhead secs captured when play (re)starts,
// so the loop derives the target time from real elapsed time and stays
// time-accurate even when frame extraction can't keep up (it drops frames).
let playStartWall = 0;
let playStartHead = 0;

export const useVideoEditorStore = create<VideoEditorState>((set, get) => ({
	sourcePath: null,
	sourceName: null,
	info: null,
	pendingOps: [],
	playheadSecs: 0,
	frameUrl: null,
	extracting: false,
	dirty: false,
	error: null,
	cropEditMode: false,
	cropEditorInitial: null,
	playing: false,

	load: async (path, name) => {
		if (scrubTimer) {
			clearTimeout(scrubTimer);
			scrubTimer = null;
		}
		set({
			sourcePath: path,
			sourceName: name,
			info: null,
			pendingOps: [],
			playheadSecs: 0,
			frameUrl: null,
			extracting: false,
			dirty: false,
			error: null,
			cropEditMode: false,
			cropEditorInitial: null,
			playing: false,
		});
		try {
			const info = await api.videoInfo(path);
			// Bail if the asset was switched/reset while probing.
			if (get().sourcePath !== path) return;
			// Seed the playhead a touch into the clip — frame 0 of many videos is
			// black/blank, same reason thumbnails seek to 1s.
			const seed = info.duration_secs > 2 ? 1 : 0;
			set({ info, playheadSecs: seed });
			await extractFrameAt(path, seed, set, get);
		} catch (e) {
			if (get().sourcePath !== path) return;
			set({ error: String(e) });
		}
	},

	reset: () => {
		if (scrubTimer) {
			clearTimeout(scrubTimer);
			scrubTimer = null;
		}
		frameToken += 1;
		set({
			sourcePath: null,
			sourceName: null,
			info: null,
			pendingOps: [],
			playheadSecs: 0,
			frameUrl: null,
			extracting: false,
			dirty: false,
			error: null,
			cropEditMode: false,
			cropEditorInitial: null,
			playing: false,
		});
	},

	setOps: (ops) => set({ pendingOps: ops, dirty: ops.length > 0 }),

	setCropEditMode: (b, initial) =>
		set({ cropEditMode: b, cropEditorInitial: b ? (initial ?? null) : null }),

	setPlayhead: (secs) => {
		const { info, sourcePath, playing } = get();
		if (!sourcePath) return;
		const clamped = info
			? Math.max(0, Math.min(info.duration_secs, secs))
			: Math.max(0, secs);
		set({ playheadSecs: clamped });
		// Scrubbing while playing re-anchors the loop so playback resumes from
		// the new spot; the loop owns frame extraction, so skip the debounce.
		if (playing) {
			playStartWall = performance.now();
			playStartHead = clamped;
			return;
		}
		// Debounce the actual extraction so a scrub drag doesn't spawn an ffmpeg
		// per pixel.
		if (scrubTimer) clearTimeout(scrubTimer);
		scrubTimer = setTimeout(() => {
			scrubTimer = null;
			void extractFrameAt(sourcePath, get().playheadSecs, set, get);
		}, SCRUB_DEBOUNCE_MS);
	},

	togglePlay: () => {
		const st = get();
		if (st.playing) {
			set({ playing: false });
			return;
		}
		if (!st.sourcePath || !st.info) return;
		const { start, end } = readTrim(st.pendingOps, st.info.duration_secs);
		if (end - start < 0.05) return;
		// Restart from the trim in-point if the playhead is parked at/after the
		// out-point (or before the in-point).
		let head = st.playheadSecs;
		if (head < start || head >= end - 0.02) head = start;
		playStartWall = performance.now();
		playStartHead = head;
		set({ playing: true });
		void playLoop(set, get);
	},
}));

/// Frame-stepping playback loop. Each pass derives the target time from real
/// elapsed wall-clock (so timing stays accurate even if extraction lags —
/// frames are dropped, not slowed), extracts a frame, then loops. Loops back to
/// the trim in-point at the out-point. Stops when `playing` flips false (toggle,
/// reset, or load).
async function playLoop(
	set: (partial: Partial<VideoEditorState>) => void,
	get: () => VideoEditorState,
): Promise<void> {
	const st = get();
	if (!st.playing || !st.sourcePath || !st.info) return;
	const { start, end } = readTrim(st.pendingOps, st.info.duration_secs);
	const elapsed = (performance.now() - playStartWall) / 1000;
	let target = playStartHead + elapsed;
	if (target >= end) {
		target = start;
		playStartWall = performance.now();
		playStartHead = start;
	}
	set({ playheadSecs: target });
	try {
		const tmpPath = await api.videoFrame(
			st.sourcePath,
			target,
			PLAYBACK_MAX_DIM,
		);
		const url = await mediaUrl(tmpPath);
		if (!get().playing || get().sourcePath !== st.sourcePath) return;
		set({ frameUrl: `${url}&t=${++frameToken}` });
	} catch (e) {
		set({ playing: false, error: String(e) });
		return;
	}
	if (!get().playing) return;
	// Extraction already consumed real time; loop immediately (no setTimeout).
	void playLoop(set, get);
}

/// Extract + display the frame at `secs`, guarding against out-of-order
/// results. Shared by `load` (immediate) and `setPlayhead` (debounced).
async function extractFrameAt(
	path: string,
	secs: number,
	set: (partial: Partial<VideoEditorState>) => void,
	get: () => VideoEditorState,
): Promise<void> {
	const token = ++frameToken;
	set({ extracting: true });
	try {
		const tmpPath = await api.videoFrame(path, secs, PREVIEW_MAX_DIM);
		const url = await mediaUrl(tmpPath);
		// Discard if a newer extraction superseded us or the video changed.
		if (frameToken !== token || get().sourcePath !== path) return;
		// Cache-bust: successive frames reuse a rotating temp filename, so the
		// URL can repeat — append the token to force the <img> to reload.
		set({ frameUrl: `${url}&t=${token}`, extracting: false, error: null });
	} catch (e) {
		if (frameToken !== token || get().sourcePath !== path) return;
		set({ extracting: false, error: String(e) });
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Frontend control surface for the native Rust audio player. Loads the
//! requested file, subscribes to `audio:position` / `audio:state` events, and
//! exposes imperative transport actions. The Rust engine is a single global
//! player, so only one of these is meaningfully active at a time; the hook
//! issues `audio_stop` on unmount so playback doesn't continue into the void
//! after leaving the Music workspace. (Adapted from Starling's useAudioPlayer,
//! minus its clip-window plumbing.)

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/tauri";
import type { PlaybackStatus } from "@/plugins/music/stores/musicStore";

const EVT_POSITION = "audio:position";
const EVT_STATE = "audio:state";

type StateEvent = {
	status: PlaybackStatus;
	path: string | null;
	duration_seconds: number | null;
	error: string | null;
};
type PositionEvent = { position_seconds: number };

export type NativeAudio = {
	status: PlaybackStatus;
	/// Current absolute position in seconds (interpolated between event ticks).
	position: number;
	duration: number;
	error: string | null;
	/// Path the engine has confirmed loading (via a `loaded` event). Gate
	/// "play once ready" on `loadedPath === requestedPath`, not `status`.
	loadedPath: string | null;
	play: () => void;
	pause: () => void;
	playPause: () => void;
	seekTo: (seconds: number) => void;
	setVolumeDb: (db: number) => void;
};

export function useNativeAudio(path: string | null, volumeDb = 0): NativeAudio {
	const [status, setStatus] = useState<PlaybackStatus>("idle");
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [loadedPath, setLoadedPath] = useState<string | null>(null);

	const loadedPathRef = useRef<string | null>(null);
	const volumeRef = useRef(volumeDb);
	useEffect(() => {
		volumeRef.current = volumeDb;
	}, [volumeDb]);

	// Smooth interpolation between ~30Hz position events → 60fps cursor.
	const lastEventRef = useRef<{ at: number; pos: number } | null>(null);
	const playingRef = useRef(false);
	useEffect(() => {
		playingRef.current = status === "playing";
	}, [status]);
	useEffect(() => {
		if (status !== "playing") return;
		let raf = 0;
		const tick = () => {
			const last = lastEventRef.current;
			if (last && playingRef.current) {
				setPosition(last.pos + (performance.now() - last.at) / 1000);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [status]);

	// Subscribe + load in one effect so the listeners are registered before the
	// load fires (Tauri events don't replay missed messages).
	useEffect(() => {
		let unPos: UnlistenFn | null = null;
		let unState: UnlistenFn | null = null;
		let cancelled = false;
		const expected = path;
		loadedPathRef.current = expected;
		setStatus("idle");
		setPosition(0);
		setError(null);
		setLoadedPath(null);

		(async () => {
			const upos = await listen<PositionEvent>(EVT_POSITION, (e) => {
				if (cancelled) return;
				const pos = e.payload.position_seconds;
				lastEventRef.current = { at: performance.now(), pos };
				setPosition(pos);
			});
			const ustate = await listen<StateEvent>(EVT_STATE, (e) => {
				if (cancelled) return;
				const p = e.payload;
				// Ignore events targeting a different load.
				if (p.path !== null && loadedPathRef.current !== null && p.path !== loadedPathRef.current) {
					return;
				}
				setStatus(p.status);
				if (p.status === "loaded" && p.path) setLoadedPath(p.path);
				if (p.duration_seconds != null) setDuration(p.duration_seconds);
				setError(p.status === "error" ? p.error : null);
				if (p.status === "ended") {
					setPosition(0);
					lastEventRef.current = null;
				}
				if (p.status !== "playing") lastEventRef.current = null;
			});
			if (cancelled) {
				upos();
				ustate();
				return;
			}
			unPos = upos;
			unState = ustate;
			if (!expected) return;
			try {
				await api.audioLoad(expected, volumeRef.current);
			} catch (e) {
				if (!cancelled) {
					setStatus("error");
					setError(String(e));
				}
			}
		})();

		return () => {
			cancelled = true;
			unPos?.();
			unState?.();
			void api.audioStop().catch(() => {});
		};
	}, [path]);

	const play = useCallback(() => {
		void api.audioPlay().catch((e) => setError(String(e)));
	}, []);
	const pause = useCallback(() => {
		void api.audioPause().catch((e) => setError(String(e)));
	}, []);
	const playPause = useCallback(() => {
		const cmd = status === "playing" ? api.audioPause() : api.audioPlay();
		void cmd.catch((e) => setError(String(e)));
	}, [status]);
	const seekTo = useCallback((seconds: number) => {
		void api.audioSeek(seconds).catch((e) => setError(String(e)));
	}, []);
	const setVolumeDb = useCallback((db: number) => {
		void api.audioSetVolume(db).catch((e) => setError(String(e)));
	}, []);

	return { status, position, duration, error, loadedPath, play, pause, playPause, seekTo, setVolumeDb };
}

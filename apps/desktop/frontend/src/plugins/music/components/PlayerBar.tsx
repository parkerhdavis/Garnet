// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Music workflow's player bar: now-playing, transport (prev/play/next),
//! a seekable waveform, and a volume control. Playback runs through the native
//! Rust engine (useNativeAudio); the waveform renders pre-computed peaks.

import { useEffect, useState } from "react";
import {
	HiBackward,
	HiForward,
	HiPause,
	HiPlay,
	HiSpeakerWave,
	HiSpeakerXMark,
} from "react-icons/hi2";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";
import { Waveform } from "@/plugins/music/components/Waveform";
import { useNativeAudio } from "@/plugins/music/hooks/useNativeAudio";
import { usePeaks } from "@/plugins/music/hooks/usePeaks";
import { formatDuration } from "@/plugins/music/lib/format";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

/// Linear 0..1 volume → dB for the engine (0 → effectively silent).
function volumeToDb(vol: number): number {
	return vol <= 0 ? -60 : 20 * Math.log10(vol);
}

export function PlayerBar() {
	const nowPlaying = useMusicStore((s) => s.nowPlaying);
	const next = useMusicStore((s) => s.next);
	const prev = useMusicStore((s) => s.prev);
	const hasNext = useMusicStore((s) => s.hasNext);
	const hasPrev = useMusicStore((s) => s.hasPrev);
	const setPlaybackStatus = useMusicStore((s) => s.setPlaybackStatus);

	const [volume, setVolume] = useState(1);
	const volumeDb = volumeToDb(volume);

	const path = nowPlaying?.abs_path ?? null;
	const player = useNativeAudio(path, volumeDb);
	const peaks = usePeaks(path);

	// Auto-play a freshly loaded track (nowPlaying is only set by play actions).
	useEffect(() => {
		if (path && player.loadedPath === path) player.play();
	}, [player.loadedPath, path, player.play]);

	// Auto-advance to the next track when the current one ends.
	useEffect(() => {
		if (player.status === "ended" && hasNext()) next();
	}, [player.status, hasNext, next]);

	// Mirror status into the store so the track list can show the playing mark.
	useEffect(() => {
		setPlaybackStatus(player.status);
	}, [player.status, setPlaybackStatus]);

	// Apply live volume changes.
	useEffect(() => {
		player.setVolumeDb(volumeDb);
	}, [volumeDb, player.setVolumeDb]);

	if (!nowPlaying) return null;

	const isPlaying = player.status === "playing";

	return (
		<div className="flex items-center gap-3 border-t border-base-300 bg-base-100 px-4 py-2 shrink-0">
			{/* Now playing */}
			<div className="flex w-48 min-w-0 shrink-0 items-center gap-3">
				<AlbumArt
					absPath={nowPlaying.abs_path}
					size={96}
					className="size-11 shrink-0"
					rounded="rounded"
				/>
				<div className="min-w-0">
					<div className="truncate text-sm font-medium leading-tight">{nowPlaying.title}</div>
					<div className="truncate text-xs text-base-content/60">{nowPlaying.artist}</div>
				</div>
			</div>

			{/* Transport */}
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					className="btn btn-ghost btn-sm btn-circle"
					disabled={!hasPrev()}
					onClick={prev}
					title="Previous"
				>
					<HiBackward className="size-4" />
				</button>
				<button
					type="button"
					className="btn btn-primary btn-sm btn-circle"
					onClick={player.playPause}
					title={isPlaying ? "Pause" : "Play"}
				>
					{isPlaying ? <HiPause className="size-4" /> : <HiPlay className="size-4" />}
				</button>
				<button
					type="button"
					className="btn btn-ghost btn-sm btn-circle"
					disabled={!hasNext()}
					onClick={next}
					title="Next"
				>
					<HiForward className="size-4" />
				</button>
			</div>

			{/* Waveform + time */}
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span className="w-9 text-right text-[11px] tabular-nums text-base-content/50">
					{formatDuration(player.position)}
				</span>
				<div className="min-w-0 flex-1">
					{peaks && peaks.length > 0 && player.duration > 0 ? (
						<Waveform
							peaks={peaks}
							duration={player.duration}
							position={player.position}
							height={40}
							onSeek={player.seekTo}
						/>
					) : (
						<div className="h-10 rounded bg-base-200" />
					)}
				</div>
				<span className="w-9 text-[11px] tabular-nums text-base-content/50">
					{formatDuration(player.duration)}
				</span>
			</div>

			{/* Volume */}
			<div className="flex w-28 shrink-0 items-center gap-1">
				<button
					type="button"
					className="btn btn-ghost btn-xs btn-circle"
					onClick={() => setVolume(volume > 0 ? 0 : 1)}
					title={volume > 0 ? "Mute" : "Unmute"}
				>
					{volume > 0 ? (
						<HiSpeakerWave className="size-4" />
					) : (
						<HiSpeakerXMark className="size-4" />
					)}
				</button>
				<input
					type="range"
					min={0}
					max={1}
					step={0.01}
					value={volume}
					onChange={(e) => setVolume(Number(e.target.value))}
					className="range range-xs flex-1"
					aria-label="Volume"
				/>
			</div>
		</div>
	);
}

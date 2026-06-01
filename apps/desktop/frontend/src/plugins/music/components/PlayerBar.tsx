// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Music workflow's player bar: now-playing, transport (prev/play/next),
//! a seekable waveform, and a volume control. Playback runs through the native
//! Rust engine (useNativeAudio); the waveform renders pre-computed peaks.

import { useEffect, useMemo, useRef, useState } from "react";
import {
	HiArrowPath,
	HiArrowsRightLeft,
	HiBackward,
	HiChevronDown,
	HiChevronUp,
	HiForward,
	HiPause,
	HiPlay,
	HiQueueList,
	HiSpeakerWave,
	HiSpeakerXMark,
} from "react-icons/hi2";
import { useNavigate } from "react-router-dom";
import type { MusicTrack } from "@/lib/tauri";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";
import { HiResBadge } from "@/plugins/music/components/HiResBadge";
import { PlayingBars } from "@/plugins/music/components/PlayingBars";
import { Waveform } from "@/plugins/music/components/Waveform";
import { useNativeAudio } from "@/plugins/music/hooks/useNativeAudio";
import { usePeaks } from "@/plugins/music/hooks/usePeaks";
import {
	formatDuration,
	isHiRes,
	qualityShort,
} from "@/plugins/music/lib/format";
import { albumIdForTrack } from "@/plugins/music/lib/grouping";
import { useMusicStore } from "@/plugins/music/stores/musicStore";
import { useWorkspacesStore } from "@/stores/workspacesStore";

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
	const shuffle = useMusicStore((s) => s.shuffle);
	const toggleShuffle = useMusicStore((s) => s.toggleShuffle);
	const repeat = useMusicStore((s) => s.repeat);
	const cycleRepeat = useMusicStore((s) => s.cycleRepeat);
	const queueOpen = useMusicStore((s) => s.queueOpen);
	const toggleQueue = useMusicStore((s) => s.toggleQueue);
	const playerCollapsed = useMusicStore((s) => s.playerCollapsed);
	const setPlayerCollapsed = useMusicStore((s) => s.setPlayerCollapsed);
	const playbackWorkspaceId = useMusicStore((s) => s.playbackWorkspaceId);
	const workspaces = useWorkspacesStore((s) => s.workspaces);
	const navigate = useNavigate();

	// Where clicking the now-playing track navigates: the workspace it was
	// played from (its scope is guaranteed to contain the album/artist). Falls
	// back to any music workspace if that one is gone — null only if there's no
	// music workspace at all, in which case the labels aren't clickable.
	const navWorkspaceId = useMemo(() => {
		if (
			playbackWorkspaceId != null &&
			workspaces.some((w) => w.id === playbackWorkspaceId)
		) {
			return playbackWorkspaceId;
		}
		return workspaces.find((w) => w.type === "music")?.id ?? null;
	}, [playbackWorkspaceId, workspaces]);

	const [volume, setVolume] = useState(1);
	const volumeDb = volumeToDb(volume);

	const path = nowPlaying?.abs_path ?? null;
	const player = useNativeAudio(path, volumeDb);
	const peaks = usePeaks(path);

	// Auto-play a freshly loaded track (nowPlaying is only set by play actions).
	useEffect(() => {
		if (path && player.loadedPath === path) player.play();
	}, [player.loadedPath, path, player.play]);

	// On track end: repeat-one replays in place; otherwise advance the queue
	// (next() wraps when repeat-all is on).
	useEffect(() => {
		if (player.status !== "ended") return;
		if (repeat === "one") {
			player.seekTo(0);
			player.play();
		} else if (hasNext()) {
			next();
		}
	}, [player.status, repeat, hasNext, next, player.seekTo, player.play]);

	// Mirror status into the store so the track list can show the playing mark.
	useEffect(() => {
		setPlaybackStatus(player.status);
	}, [player.status, setPlaybackStatus]);

	// Bring a collapsed bar back when playback resumes from a pause. (Starting
	// new playback already clears the flag in the store.) Tracking the previous
	// status keeps an end-of-track auto-advance — ended → playing — from
	// reopening it, so the bar stays hidden across a whole album if you want.
	const prevStatusRef = useRef(player.status);
	useEffect(() => {
		if (prevStatusRef.current === "paused" && player.status === "playing") {
			setPlayerCollapsed(false);
		}
		prevStatusRef.current = player.status;
	}, [player.status, setPlayerCollapsed]);

	// Apply live volume changes.
	useEffect(() => {
		player.setVolumeDb(volumeDb);
	}, [volumeDb, player.setVolumeDb]);

	if (!nowPlaying) return null;

	const isPlaying = player.status === "playing";

	// Collapsed: hide the bar but keep this component (and its audio hook)
	// mounted so playback continues — unmounting would fire audio_stop. A small
	// floating control restores it; it also reopens on its own when playback
	// resumes (see the effect above) or when something new is played.
	if (playerCollapsed) {
		return (
			<CollapsedPlayer
				track={nowPlaying}
				isPlaying={isPlaying}
				onExpand={() => setPlayerCollapsed(false)}
			/>
		);
	}

	const quality = qualityShort(nowPlaying);
	const hiRes = isHiRes(nowPlaying);

	const canNavigate = navWorkspaceId != null;
	const goToAlbum = () => {
		if (navWorkspaceId == null) return;
		navigate(
			`/workspaces/${navWorkspaceId}?album=${encodeURIComponent(albumIdForTrack(nowPlaying))}`,
		);
	};
	const goToArtist = () => {
		if (navWorkspaceId == null) return;
		navigate(
			`/workspaces/${navWorkspaceId}?artist=${encodeURIComponent(nowPlaying.album_artist)}`,
		);
	};

	return (
		<div className="flex items-center gap-3 border-t border-base-300 bg-base-100 px-4 py-2 shrink-0">
			{/* Now playing — cover + title open the album, artist opens the
			    artist, in the Music Library workspace it was played from. */}
			<div className="flex w-56 min-w-0 shrink-0 items-center gap-3">
				<button
					type="button"
					onClick={goToAlbum}
					disabled={!canNavigate}
					title={canNavigate ? `Go to ${nowPlaying.album}` : undefined}
					className="shrink-0 rounded transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none"
				>
					<AlbumArt
						absPath={nowPlaying.abs_path}
						className="size-11"
						rounded="rounded"
					/>
				</button>
				<div className="min-w-0">
					<button
						type="button"
						onClick={goToAlbum}
						disabled={!canNavigate}
						title={canNavigate ? `Go to ${nowPlaying.album}` : undefined}
						className="block max-w-full truncate text-left text-sm font-medium leading-tight hover:underline disabled:no-underline"
					>
						{nowPlaying.title}
					</button>
					<div className="flex min-w-0 items-center gap-1.5">
						<button
							type="button"
							onClick={goToArtist}
							disabled={!canNavigate}
							title={
								canNavigate ? `Go to ${nowPlaying.album_artist}` : undefined
							}
							className="min-w-0 truncate text-left text-xs text-base-content/60 hover:text-primary hover:underline disabled:text-base-content/60 disabled:no-underline"
						>
							{nowPlaying.artist}
						</button>
						{hiRes ? (
							<HiResBadge className="badge-xs shrink-0 text-[9px]" />
						) : (
							quality && (
								<span className="badge badge-xs shrink-0 border-0 bg-base-content/10 text-[9px] font-medium text-base-content/55">
									{quality}
								</span>
							)
						)}
					</div>
				</div>
			</div>

			{/* Transport */}
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					className={`btn btn-ghost btn-sm btn-circle ${shuffle ? "text-primary" : ""}`}
					onClick={toggleShuffle}
					title={shuffle ? "Shuffle: on" : "Shuffle: off"}
				>
					<HiArrowsRightLeft className="size-4" />
				</button>
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
					{isPlaying ? (
						<HiPause className="size-4" />
					) : (
						<HiPlay className="size-4" />
					)}
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
				<button
					type="button"
					className={`btn btn-ghost btn-sm btn-circle relative ${
						repeat !== "off" ? "text-primary" : ""
					}`}
					onClick={cycleRepeat}
					title={`Repeat: ${repeat}`}
				>
					<HiArrowPath className="size-4" />
					{repeat === "one" && (
						<span className="absolute right-1.5 top-1 text-[8px] font-bold leading-none">
							1
						</span>
					)}
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
				<span className="w-10 text-[11px] tabular-nums text-base-content/50">
					{player.duration > 0
						? `-${formatDuration(Math.max(0, player.duration - player.position))}`
						: formatDuration(player.duration)}
				</span>
			</div>

			{/* Queue + volume */}
			<button
				type="button"
				className={`btn btn-ghost btn-sm btn-circle shrink-0 ${queueOpen ? "text-primary" : ""}`}
				onClick={toggleQueue}
				title="Queue"
			>
				<HiQueueList className="size-4" />
			</button>
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

			{/* Collapse: hides the bar (playback keeps going); it reopens when
			    playback resumes or something new is played. */}
			<button
				type="button"
				className="btn btn-ghost btn-sm btn-circle shrink-0"
				onClick={() => setPlayerCollapsed(true)}
				title="Hide player"
			>
				<HiChevronDown className="size-4" />
			</button>
		</div>
	);
}

/// Compact stand-in shown when the player bar is collapsed: identifies what's
/// playing and restores the full bar on click. Rendered (instead of the bar)
/// by PlayerBar itself, so the audio hook stays mounted and playback continues.
function CollapsedPlayer({
	track,
	isPlaying,
	onExpand,
}: {
	track: MusicTrack;
	isPlaying: boolean;
	onExpand: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onExpand}
			title="Show player"
			className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-base-300 bg-base-100 py-1.5 pl-1.5 pr-3 shadow-xl transition hover:bg-base-200"
		>
			<AlbumArt
				absPath={track.abs_path}
				className="size-8"
				rounded="rounded-full"
			/>
			{isPlaying ? (
				<PlayingBars className="text-primary" />
			) : (
				<HiChevronUp className="size-4 text-base-content/60" />
			)}
		</button>
	);
}

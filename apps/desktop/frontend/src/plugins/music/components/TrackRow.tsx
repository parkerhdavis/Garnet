// SPDX-License-Identifier: AGPL-3.0-or-later
//! One row in an album's track list. Shows track number (or a speaker icon when
//! it's the current track), title, and duration. Clicking plays it.

import { HiOutlineSpeakerWave } from "react-icons/hi2";
import type { MusicTrack } from "@/lib/tauri";
import { formatDuration } from "@/plugins/music/lib/format";

export function TrackRow({
	track,
	index,
	isCurrent,
	isPlaying,
	onPlay,
}: {
	track: MusicTrack;
	index: number;
	isCurrent: boolean;
	isPlaying: boolean;
	onPlay: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPlay}
			className={`group flex w-full items-center gap-3 rounded px-3 py-1.5 text-left hover:bg-base-200 ${
				isCurrent ? "text-primary" : ""
			}`}
		>
			<span className="w-5 shrink-0 text-right text-xs tabular-nums text-base-content/45">
				{isCurrent && isPlaying ? (
					<HiOutlineSpeakerWave className="inline size-3.5" />
				) : (
					(track.track_no ?? index + 1)
				)}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">{track.title}</span>
			<span className="shrink-0 text-xs tabular-nums text-base-content/45">
				{formatDuration(track.duration_secs)}
			</span>
		</button>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! One row in an album's track table. The leading cell shows the track number,
//! swapping to a play triangle on hover and to an animated equalizer for the
//! current track. Columns align with the header via the shared `TRACK_GRID`.

import { HiPause, HiPlay } from "react-icons/hi2";
import type { MusicTrack } from "@/lib/tauri";
import { PlayingBars } from "@/plugins/music/components/PlayingBars";
import { formatDuration, qualityShort } from "@/plugins/music/lib/format";

/// Shared column template for the header + rows: # · title · quality · time.
export const TRACK_GRID = "grid grid-cols-[1.75rem_1fr_auto_3.25rem] items-center gap-x-4";

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
	const quality = qualityShort(track);
	return (
		<button
			type="button"
			onClick={onPlay}
			className={`${TRACK_GRID} group w-full rounded-md px-3 py-1.5 text-left transition-colors hover:bg-base-content/5 ${
				isCurrent ? "bg-base-content/5" : ""
			}`}
		>
			<span
				className={`flex justify-center text-xs tabular-nums ${
					isCurrent ? "text-primary" : "text-base-content/45"
				}`}
			>
				{isCurrent ? (
					isPlaying ? (
						<PlayingBars className="text-primary" />
					) : (
						<HiPause className="size-3.5" />
					)
				) : (
					<>
						<span className="group-hover:hidden">{track.track_no ?? index + 1}</span>
						<HiPlay className="hidden size-3.5 group-hover:block" />
					</>
				)}
			</span>
			<span className={`min-w-0 truncate text-sm ${isCurrent ? "font-medium text-primary" : ""}`}>
				{track.title}
			</span>
			<span className="truncate text-[10px] font-medium uppercase tracking-wide text-base-content/40">
				{quality ?? ""}
			</span>
			<span className="text-right text-xs tabular-nums text-base-content/45">
				{formatDuration(track.duration_secs)}
			</span>
		</button>
	);
}

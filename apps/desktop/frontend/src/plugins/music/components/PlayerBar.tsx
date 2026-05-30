// SPDX-License-Identifier: AGPL-3.0-or-later
//! Now-playing strip at the bottom of the Music workflow. This minimal version
//! shows the current track; the player commit adds the native-audio transport
//! controls + the seekable waveform.

import type { MusicTrack } from "@/lib/tauri";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

export function PlayerBar() {
	const nowPlaying = useMusicStore((s) => s.nowPlaying);
	if (!nowPlaying) return null;
	return (
		<div className="flex items-center gap-3 border-t border-base-300 bg-base-100 px-4 py-2 shrink-0">
			<NowPlaying track={nowPlaying} />
		</div>
	);
}

export function NowPlaying({ track }: { track: MusicTrack }) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<AlbumArt absPath={track.abs_path} size={96} className="size-11 shrink-0" rounded="rounded" />
			<div className="min-w-0">
				<div className="truncate text-sm font-medium leading-tight">{track.title}</div>
				<div className="truncate text-xs text-base-content/60">{track.artist}</div>
			</div>
		</div>
	);
}

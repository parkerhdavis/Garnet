// SPDX-License-Identifier: AGPL-3.0-or-later
//! Album detail: a large cover + album info header above the track list. Tracks
//! play through the music store's queue (the whole album becomes the queue).

import { HiChevronLeft, HiPlay } from "react-icons/hi2";
import type { MusicAlbum } from "@/lib/tauri";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";
import { TrackRow } from "@/plugins/music/components/TrackRow";
import { albumSubtitle } from "@/plugins/music/lib/format";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

export function AlbumDetailView({ album, onBack }: { album: MusicAlbum; onBack: () => void }) {
	const playTrack = useMusicStore((s) => s.playTrack);
	const playAlbum = useMusicStore((s) => s.playAlbum);
	const nowPlaying = useMusicStore((s) => s.nowPlaying);
	const playbackStatus = useMusicStore((s) => s.playbackStatus);

	return (
		<div>
			<header className="flex items-end gap-5 border-b border-base-300 p-4">
				<AlbumArt
					absPath={album.cover_abs_path}
					size={400}
					className="size-40 shrink-0 shadow-md"
				/>
				<div className="min-w-0 flex-1">
					<button
						type="button"
						onClick={onBack}
						className="btn btn-ghost btn-xs -ml-2 mb-2 gap-1"
					>
						<HiChevronLeft className="size-4" />
						Albums
					</button>
					<h1 className="truncate text-2xl font-bold leading-tight">{album.album}</h1>
					<div className="truncate text-base-content/70">{album.album_artist}</div>
					<div className="mt-1 text-xs text-base-content/50">
						{albumSubtitle(album.track_count, album.total_duration_secs, album.year)}
					</div>
					<button
						type="button"
						onClick={() => playAlbum(album)}
						className="btn btn-primary btn-sm mt-3 gap-1"
					>
						<HiPlay className="size-4" />
						Play
					</button>
				</div>
			</header>

			<ul className="p-2">
				{album.tracks.map((track, i) => {
					const isCurrent = nowPlaying?.asset_id === track.asset_id;
					return (
						<li key={track.asset_id}>
							<TrackRow
								track={track}
								index={i}
								isCurrent={isCurrent}
								isPlaying={isCurrent && playbackStatus === "playing"}
								onPlay={() => playTrack(track, album.tracks)}
							/>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

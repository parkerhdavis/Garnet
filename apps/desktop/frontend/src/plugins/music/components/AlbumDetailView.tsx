// SPDX-License-Identifier: AGPL-3.0-or-later
//! Album detail: a large cover + album info over a blurred album-art backdrop,
//! above the track table. Tracks play through the music store's queue (the
//! whole album becomes the queue); Shuffle plays it in random order.

import { HiArrowsRightLeft, HiChevronLeft, HiPlay } from "react-icons/hi2";
import type { MusicAlbum } from "@/lib/tauri";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";
import { HiResBadge } from "@/plugins/music/components/HiResBadge";
import { TRACK_GRID, TrackRow } from "@/plugins/music/components/TrackRow";
import { albumSubtitle, isHiRes, qualityChips } from "@/plugins/music/lib/format";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

export function AlbumDetailView({ album, onBack }: { album: MusicAlbum; onBack: () => void }) {
	const playTrack = useMusicStore((s) => s.playTrack);
	const playAlbum = useMusicStore((s) => s.playAlbum);
	const playAlbumShuffled = useMusicStore((s) => s.playAlbumShuffled);
	const nowPlaying = useMusicStore((s) => s.nowPlaying);
	const playbackStatus = useMusicStore((s) => s.playbackStatus);

	const rep = album.tracks[0];
	const chips = rep ? qualityChips(rep) : [];
	const hiRes = rep ? isHiRes(rep) : false;

	return (
		<div>
			<div className="relative overflow-hidden border-b border-base-300">
				{/* Blurred album-art backdrop, faded into the page background.
				    Painted first (behind) with the header relative on top. */}
				<div className="pointer-events-none absolute inset-0" aria-hidden>
					<AlbumArt
						absPath={album.cover_abs_path}
						rounded=""
						className="h-full w-full scale-125 blur-3xl opacity-25 saturate-150"
					/>
					<div className="absolute inset-0 bg-gradient-to-t from-base-100 via-base-100/85 to-base-100/40" />
				</div>

				<header className="relative flex items-end gap-5 p-5">
					<AlbumArt
						absPath={album.cover_abs_path}
						className="size-44 shrink-0 rounded-lg shadow-2xl ring-1 ring-base-content/10"
					/>
					<div className="min-w-0 flex-1 pb-1">
						<button
							type="button"
							onClick={onBack}
							className="btn btn-ghost btn-xs -ml-2 mb-2 gap-1"
						>
							<HiChevronLeft className="size-4" />
							Albums
						</button>
						<h1 className="truncate text-3xl font-bold leading-tight">{album.album}</h1>
						<div className="truncate text-lg text-base-content/80">{album.album_artist}</div>
						<div className="mt-1 text-xs text-base-content/55">
							{albumSubtitle(album.track_count, album.total_duration_secs, album.year)}
						</div>
						{chips.length > 0 && (
							<div className="mt-2 flex flex-wrap items-center gap-1.5">
								{hiRes && <HiResBadge />}
								{chips.map((c, i) => (
									<span
										key={c}
										className={`badge badge-sm border-0 ${
											i === 0
												? "bg-primary/15 font-semibold text-primary"
												: "bg-base-content/10 text-base-content/70"
										}`}
									>
										{c}
									</span>
								))}
							</div>
						)}
						<div className="mt-3 flex items-center gap-2">
							<button
								type="button"
								onClick={() => playAlbum(album)}
								className="btn btn-primary btn-sm gap-1 rounded-full px-5"
							>
								<HiPlay className="size-4" />
								Play
							</button>
							<button
								type="button"
								onClick={() => playAlbumShuffled(album)}
								className="btn btn-ghost btn-sm gap-1 rounded-full"
							>
								<HiArrowsRightLeft className="size-4" />
								Shuffle
							</button>
						</div>
					</div>
				</header>
			</div>

			{/* Track table */}
			<div className="p-2">
				<div
					className={`${TRACK_GRID} px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/40`}
				>
					<span className="text-center">#</span>
					<span>Title</span>
					<span>Quality</span>
					<span className="text-right">Time</span>
				</div>
				<div className="h-px bg-base-300" />
				<ul className="mt-1">
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
		</div>
	);
}

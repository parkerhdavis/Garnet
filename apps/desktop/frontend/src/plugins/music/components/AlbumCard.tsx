// SPDX-License-Identifier: AGPL-3.0-or-later
//! One album in the grid: cover + title + artist. The cover (and title) open
//! the album; a play button fades in over the cover on hover to play it
//! straight from the grid.

import { HiPlay } from "react-icons/hi2";
import type { MusicAlbum } from "@/lib/tauri";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

export function AlbumCard({ album, onOpen }: { album: MusicAlbum; onOpen: () => void }) {
	const playAlbum = useMusicStore((s) => s.playAlbum);
	return (
		<div className="group flex flex-col gap-2">
			<div className="relative">
				<button type="button" onClick={onOpen} className="block w-full" title={album.album}>
					<AlbumArt
						absPath={album.cover_abs_path}
						className="w-full aspect-square shadow-sm transition-shadow group-hover:shadow-lg"
					/>
				</button>
				<button
					type="button"
					onClick={() => playAlbum(album)}
					title="Play album"
					className="absolute bottom-2 right-2 flex size-10 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-content opacity-0 shadow-lg transition-all duration-200 hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100"
				>
					<HiPlay className="size-5" />
				</button>
			</div>
			<button type="button" onClick={onOpen} className="min-w-0 text-left">
				<div className="truncate text-sm font-medium leading-tight">{album.album}</div>
				<div className="truncate text-xs text-base-content/60">{album.album_artist}</div>
			</button>
		</div>
	);
}

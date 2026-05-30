// SPDX-License-Identifier: AGPL-3.0-or-later
//! One album in the grid: cover + title + artist. Clicking drills into the
//! album's track list.

import type { MusicAlbum } from "@/lib/tauri";
import { AlbumArt } from "@/plugins/music/components/AlbumArt";

export function AlbumCard({ album, onClick }: { album: MusicAlbum; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="group flex flex-col gap-2 text-left">
			<AlbumArt
				absPath={album.cover_abs_path}
				className="w-full aspect-square shadow-sm transition-shadow group-hover:shadow-md"
			/>
			<div className="min-w-0">
				<div className="truncate text-sm font-medium leading-tight">{album.album}</div>
				<div className="truncate text-xs text-base-content/60">{album.album_artist}</div>
			</div>
		</button>
	);
}

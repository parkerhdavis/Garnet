// SPDX-License-Identifier: AGPL-3.0-or-later
//! Artists view: album-artist sections, each with its own album grid. The
//! section heading is clickable to focus that artist.

import type { MusicAlbum } from "@/lib/tauri";
import { AlbumGrid } from "@/plugins/music/components/AlbumGrid";
import { groupAlbumsByArtist } from "@/plugins/music/lib/grouping";

export function ArtistView({
	albums,
	onSelect,
	onArtist,
}: {
	albums: MusicAlbum[];
	onSelect: (id: string) => void;
	onArtist?: (artist: string) => void;
}) {
	const groups = groupAlbumsByArtist(albums);
	return (
		<div className="flex flex-col">
			{groups.map((g) => (
				<section
					key={g.artist}
					className="border-b border-base-300/60 last:border-0"
				>
					<div className="flex items-baseline gap-2 px-4 pt-4 pb-0.5">
						{onArtist ? (
							<button
								type="button"
								onClick={() => onArtist(g.artist)}
								className="truncate text-base font-semibold hover:text-primary hover:underline"
							>
								{g.artist}
							</button>
						) : (
							<h2 className="truncate text-base font-semibold">{g.artist}</h2>
						)}
						<span className="shrink-0 text-xs text-base-content/50">
							{g.albumCount} {g.albumCount === 1 ? "album" : "albums"}
						</span>
					</div>
					<AlbumGrid
						albums={g.albums}
						onSelect={onSelect}
						onArtist={onArtist}
					/>
				</section>
			))}
		</div>
	);
}

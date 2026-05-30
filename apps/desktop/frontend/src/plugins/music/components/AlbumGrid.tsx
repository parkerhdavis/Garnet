// SPDX-License-Identifier: AGPL-3.0-or-later
//! Responsive grid of album covers.

import type { MusicAlbum } from "@/lib/tauri";
import { AlbumCard } from "@/plugins/music/components/AlbumCard";

export function AlbumGrid({
	albums,
	onSelect,
}: {
	albums: MusicAlbum[];
	onSelect: (id: string) => void;
}) {
	return (
		<div
			className="grid gap-4 p-4"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
		>
			{albums.map((album) => (
				<AlbumCard key={album.id} album={album} onClick={() => onSelect(album.id)} />
			))}
		</div>
	);
}

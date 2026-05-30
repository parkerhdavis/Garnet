// SPDX-License-Identifier: AGPL-3.0-or-later
//! Frontend-side derivation of the artist view from the album list (the backend
//! returns albums already grouped + sorted by album-artist, so this is a cheap
//! contiguous-run regroup).

import type { MusicAlbum } from "@/lib/tauri";

export type ArtistGroup = {
	artist: string;
	albums: MusicAlbum[];
	albumCount: number;
	trackCount: number;
};

/// Group an album list (already sorted by album-artist) into artists.
export function groupAlbumsByArtist(albums: MusicAlbum[]): ArtistGroup[] {
	const byArtist = new Map<string, MusicAlbum[]>();
	for (const album of albums) {
		const list = byArtist.get(album.album_artist);
		if (list) list.push(album);
		else byArtist.set(album.album_artist, [album]);
	}
	return [...byArtist.entries()].map(([artist, list]) => ({
		artist,
		albums: list,
		albumCount: list.length,
		trackCount: list.reduce((n, a) => n + a.track_count, 0),
	}));
}

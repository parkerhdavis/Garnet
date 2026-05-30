// SPDX-License-Identifier: AGPL-3.0-or-later
//! Frontend-side derivation of the artist view from the album list (the backend
//! returns albums already grouped + sorted by album-artist, so this is a cheap
//! contiguous-run regroup).

import type { MusicAlbum, MusicTrack } from "@/lib/tauri";

/// Separator joining album-artist + album into an album id. Mirrors the U+0001
/// the backend uses in `format!("{album_artist}\u{1}{album}")` (music/mod.rs
/// `group_tracks`) — a control char that can't appear in real tag text.
const ALBUM_ID_SEP = String.fromCharCode(1);

/// The album id a track belongs to, matching the backend's album ids so the
/// player bar can address the now-playing track's album in the grid.
export function albumIdForTrack(track: MusicTrack): string {
	return `${track.album_artist}${ALBUM_ID_SEP}${track.album}`;
}

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

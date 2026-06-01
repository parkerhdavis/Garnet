// SPDX-License-Identifier: AGPL-3.0-or-later
//! Music Library's command-palette contribution: search the audio library by
//! album and artist. Results navigate into the music workspace's `?album=` /
//! `?artist=` views (the same URLs the player bar uses). Falls back to nothing
//! when there's no music workspace to land in.

import { HiMusicalNote, HiUserGroup } from "react-icons/hi2";
import { api, type MusicLibrary } from "@/lib/tauri";
import type {
	PaletteItemContribution,
	PaletteSourceContribution,
} from "@/plugins/types";
import { useWorkspacesStore } from "@/stores/workspacesStore";

const ARTIST_LIMIT = 4;
const ALBUM_LIMIT = 6;
const CACHE_MS = 30_000;

// The full grouped library is reused across keystrokes (and palette opens)
// rather than re-queried on every debounce tick. Short TTL so newly-indexed
// audio shows up without a restart.
let cache: { at: number; lib: MusicLibrary } | null = null;

async function loadLibrary(): Promise<MusicLibrary> {
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.lib;
	const lib = await api.listMusicLibrary(null, null);
	cache = { at: Date.now(), lib };
	return lib;
}

export const musicPaletteSource: PaletteSourceContribution = {
	id: "music",
	group: "Music",
	async search(query) {
		const wsId = useWorkspacesStore
			.getState()
			.workspaces.find((w) => w.type === "music")?.id;
		if (wsId == null) return [];

		const q = query.toLowerCase();
		const lib = await loadLibrary();
		const items: PaletteItemContribution[] = [];

		const artists = [...new Set(lib.albums.map((a) => a.album_artist))]
			.filter((name) => name.toLowerCase().includes(q))
			.slice(0, ARTIST_LIMIT);
		for (const name of artists) {
			items.push({
				id: `artist-${name}`,
				label: name,
				sublabel: "Artist",
				icon: HiUserGroup,
				to: `/workspaces/${wsId}?artist=${encodeURIComponent(name)}`,
			});
		}

		const albums = lib.albums
			.filter(
				(a) =>
					a.album.toLowerCase().includes(q) ||
					a.album_artist.toLowerCase().includes(q),
			)
			.slice(0, ALBUM_LIMIT);
		for (const a of albums) {
			items.push({
				id: `album-${a.id}`,
				label: a.album,
				sublabel: a.album_artist,
				icon: HiMusicalNote,
				to: `/workspaces/${wsId}?album=${encodeURIComponent(a.id)}`,
			});
		}

		return items;
	},
};

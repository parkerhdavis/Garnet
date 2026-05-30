// SPDX-License-Identifier: AGPL-3.0-or-later
//! State for the Music Library workflow: the loaded album/artist tree, the
//! browse view, and the now-playing track + queue. Transport status itself
//! comes from the native player hook (`useNativeAudio`); this store only tracks
//! *what* should be playing and the queue for next/previous.

import { create } from "zustand";
import { api, type MusicAlbum, type MusicLibrary, type MusicTrack } from "@/lib/tauri";

export type MusicView = "albums" | "artists";

export type MusicScope = {
	underPath: string | null;
	formats: string[] | null;
};

type MusicState = {
	library: MusicLibrary | null;
	loading: boolean;
	error: string | null;
	view: MusicView;
	/// Album the user has drilled into (null = grid). Resolved against the
	/// loaded library by `useSelectedAlbum`.
	selectedAlbumId: string | null;

	// Now-playing + queue (consumed by the PlayerBar).
	nowPlaying: MusicTrack | null;
	queue: MusicTrack[];
	queueIndex: number;

	load: (scope: MusicScope) => Promise<void>;
	setView: (v: MusicView) => void;
	selectAlbum: (id: string | null) => void;
	/// Start a track within a queue (typically its album's track list).
	playTrack: (track: MusicTrack, queue: MusicTrack[]) => void;
	playAlbum: (album: MusicAlbum) => void;
	next: () => void;
	prev: () => void;
	hasNext: () => boolean;
	hasPrev: () => boolean;
};

export const useMusicStore = create<MusicState>((set, get) => ({
	library: null,
	loading: true,
	error: null,
	view: "albums",
	selectedAlbumId: null,
	nowPlaying: null,
	queue: [],
	queueIndex: -1,

	load: async (scope) => {
		set({ loading: true, error: null });
		try {
			const library = await api.listMusicLibrary(scope.underPath, scope.formats);
			set({ library, loading: false });
		} catch (e) {
			set({ error: String(e), loading: false });
		}
	},

	setView: (view) => set({ view, selectedAlbumId: null }),
	selectAlbum: (selectedAlbumId) => set({ selectedAlbumId }),

	playTrack: (track, queue) => {
		const idx = queue.findIndex((t) => t.asset_id === track.asset_id);
		set({ nowPlaying: track, queue, queueIndex: idx < 0 ? 0 : idx });
	},

	playAlbum: (album) => {
		if (album.tracks.length === 0) return;
		set({ nowPlaying: album.tracks[0], queue: album.tracks, queueIndex: 0 });
	},

	next: () => {
		const { queue, queueIndex } = get();
		if (queueIndex < 0 || queueIndex + 1 >= queue.length) return;
		const i = queueIndex + 1;
		set({ nowPlaying: queue[i], queueIndex: i });
	},

	prev: () => {
		const { queue, queueIndex } = get();
		if (queueIndex <= 0) return;
		const i = queueIndex - 1;
		set({ nowPlaying: queue[i], queueIndex: i });
	},

	hasNext: () => {
		const { queue, queueIndex } = get();
		return queueIndex >= 0 && queueIndex + 1 < queue.length;
	},
	hasPrev: () => get().queueIndex > 0,
}));

/// The album the user has drilled into, resolved against the loaded library.
export function useSelectedAlbum(): MusicAlbum | null {
	const library = useMusicStore((s) => s.library);
	const id = useMusicStore((s) => s.selectedAlbumId);
	if (!library || !id) return null;
	return library.albums.find((a) => a.id === id) ?? null;
}

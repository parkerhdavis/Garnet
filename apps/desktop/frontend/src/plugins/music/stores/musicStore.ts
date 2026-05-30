// SPDX-License-Identifier: AGPL-3.0-or-later
//! State for the Music Library: the loaded album/artist tree, the browse view,
//! and playback (now-playing + queue, shuffle, repeat). The queue uses an
//! order-index model — `queue` holds the base track order and `order` is a
//! permutation of indices into it — so toggling shuffle just rebuilds `order`
//! while keeping the current track, and repeat is a property of advancing.
//! Transport status itself comes from the native player hook; this store tracks
//! *what* should play and the order.

import { create } from "zustand";
import { api, type MusicAlbum, type MusicLibrary, type MusicTrack } from "@/lib/tauri";

export type MusicView = "albums" | "artists";

export type PlaybackStatus = "idle" | "loaded" | "playing" | "paused" | "ended" | "error";

export type RepeatMode = "off" | "all" | "one";

export type MusicScope = {
	underPath: string | null;
	formats: string[] | null;
};

function identityOrder(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

/// A shuffled permutation of [0, n) with `first` placed at the front, so play
/// continues from the current track when shuffle is turned on.
function shuffledOrder(n: number, first: number): number[] {
	const rest: number[] = [];
	for (let i = 0; i < n; i++) if (i !== first) rest.push(i);
	for (let i = rest.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[rest[i], rest[j]] = [rest[j], rest[i]];
	}
	return [first, ...rest];
}

type Playback = {
	queue: MusicTrack[];
	order: number[];
	orderPos: number;
	nowPlaying: MusicTrack | null;
};

function buildPlayback(tracks: MusicTrack[], startIndex: number, shuffle: boolean): Playback {
	const n = tracks.length;
	if (n === 0) return { queue: [], order: [], orderPos: -1, nowPlaying: null };
	const idx = Math.max(0, Math.min(startIndex, n - 1));
	const order = shuffle ? shuffledOrder(n, idx) : identityOrder(n);
	const orderPos = shuffle ? 0 : idx;
	return { queue: tracks, order, orderPos, nowPlaying: tracks[order[orderPos]] };
}

type MusicState = {
	library: MusicLibrary | null;
	loading: boolean;
	error: string | null;
	view: MusicView;
	/// Album the user has drilled into (null = grid).
	selectedAlbumId: string | null;

	// Playback
	queue: MusicTrack[];
	order: number[];
	orderPos: number;
	nowPlaying: MusicTrack | null;
	shuffle: boolean;
	repeat: RepeatMode;
	playbackStatus: PlaybackStatus;
	queueOpen: boolean;

	load: (scope: MusicScope) => Promise<void>;
	setView: (v: MusicView) => void;
	selectAlbum: (id: string | null) => void;

	playTrack: (track: MusicTrack, tracks: MusicTrack[]) => void;
	playAlbum: (album: MusicAlbum) => void;
	playAlbumShuffled: (album: MusicAlbum) => void;
	toggleShuffle: () => void;
	cycleRepeat: () => void;
	toggleQueue: () => void;
	next: () => void;
	prev: () => void;
	jumpTo: (orderPos: number) => void;
	hasNext: () => boolean;
	hasPrev: () => boolean;
	setPlaybackStatus: (s: PlaybackStatus) => void;
};

export const useMusicStore = create<MusicState>((set, get) => ({
	library: null,
	loading: true,
	error: null,
	view: "albums",
	selectedAlbumId: null,

	queue: [],
	order: [],
	orderPos: -1,
	nowPlaying: null,
	shuffle: false,
	repeat: "off",
	playbackStatus: "idle",
	queueOpen: false,

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

	playTrack: (track, tracks) => {
		const i = tracks.findIndex((t) => t.asset_id === track.asset_id);
		set(buildPlayback(tracks, i < 0 ? 0 : i, get().shuffle));
	},

	playAlbum: (album) => set({ shuffle: false, ...buildPlayback(album.tracks, 0, false) }),

	playAlbumShuffled: (album) => set({ shuffle: true, ...buildPlayback(album.tracks, 0, true) }),

	toggleShuffle: () => {
		const { queue, order, orderPos, shuffle } = get();
		const nextShuffle = !shuffle;
		if (order.length === 0) {
			set({ shuffle: nextShuffle });
			return;
		}
		const currentIdx = order[orderPos];
		if (nextShuffle) {
			set({ shuffle: true, order: shuffledOrder(queue.length, currentIdx), orderPos: 0 });
		} else {
			set({ shuffle: false, order: identityOrder(queue.length), orderPos: currentIdx });
		}
	},

	cycleRepeat: () => {
		const modes: RepeatMode[] = ["off", "all", "one"];
		set({ repeat: modes[(modes.indexOf(get().repeat) + 1) % modes.length] });
	},

	toggleQueue: () => set((s) => ({ queueOpen: !s.queueOpen })),

	next: () => {
		const { order, orderPos, repeat, queue } = get();
		if (order.length === 0) return;
		let pos = orderPos + 1;
		if (pos >= order.length) {
			if (repeat === "all") pos = 0;
			else return;
		}
		set({ orderPos: pos, nowPlaying: queue[order[pos]] });
	},

	prev: () => {
		const { order, orderPos, repeat, queue } = get();
		if (order.length === 0) return;
		let pos = orderPos - 1;
		if (pos < 0) {
			if (repeat === "all") pos = order.length - 1;
			else return;
		}
		set({ orderPos: pos, nowPlaying: queue[order[pos]] });
	},

	jumpTo: (pos) => {
		const { order, queue } = get();
		if (pos < 0 || pos >= order.length) return;
		set({ orderPos: pos, nowPlaying: queue[order[pos]] });
	},

	hasNext: () => {
		const { order, orderPos, repeat } = get();
		return order.length > 0 && (orderPos + 1 < order.length || repeat === "all");
	},
	hasPrev: () => {
		const { order, orderPos, repeat } = get();
		return order.length > 0 && (orderPos > 0 || repeat === "all");
	},

	setPlaybackStatus: (playbackStatus) => set({ playbackStatus }),
}));

/// The album the user has drilled into, resolved against the loaded library.
export function useSelectedAlbum(): MusicAlbum | null {
	const library = useMusicStore((s) => s.library);
	const id = useMusicStore((s) => s.selectedAlbumId);
	if (!library || !id) return null;
	return library.albums.find((a) => a.id === id) ?? null;
}

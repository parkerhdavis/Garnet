// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-(absPath, mtime, size) pub/sub for `thumbnail:ready` events emitted
//! from the Rust thumbnail generator. A single Tauri `listen()` lives at the
//! App level (`installThumbnailReadyListener`) and fans events out through
//! this module so each AssetThumbnail can subscribe to *its own* key
//! without filtering through every event itself.

export type ThumbnailReady = {
	abs_path: string;
	mtime: number | null;
	size: number;
	/// Absolute filesystem path to the cached PNG. The frontend wraps it in
	/// `convertFileSrc` for the `<img src>`.
	path: string;
};

type Listener = (payload: ThumbnailReady) => void;

function thumbKey(absPath: string, mtime: number | null, size: number): string {
	return `${absPath}|${mtime ?? "null"}|${size}`;
}

const listeners = new Map<string, Set<Listener>>();

export function subscribeThumbnailReady(
	absPath: string,
	mtime: number | null,
	size: number,
	fn: Listener,
): () => void {
	const key = thumbKey(absPath, mtime, size);
	let set = listeners.get(key);
	if (!set) {
		set = new Set();
		listeners.set(key, set);
	}
	set.add(fn);
	return () => {
		const s = listeners.get(key);
		if (!s) return;
		s.delete(fn);
		if (s.size === 0) listeners.delete(key);
	};
}

export function emitThumbnailReady(payload: ThumbnailReady): void {
	const key = thumbKey(payload.abs_path, payload.mtime, payload.size);
	const set = listeners.get(key);
	if (!set) return;
	// Snapshot before iterating — listeners may unsubscribe themselves from
	// inside the callback (the typical case: AssetThumbnail receives its
	// thumbnail, unsubs).
	for (const fn of [...set]) fn(payload);
}

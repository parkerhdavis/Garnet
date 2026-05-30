// SPDX-License-Identifier: AGPL-3.0-or-later
//! Fetch waveform peaks for a track from the backend (computed + cached there),
//! memoized per path so switching back to a track is instant.

import { useEffect, useState } from "react";
import { api } from "@/lib/tauri";

const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[]>>();

function fetchPeaks(path: string): Promise<number[]> {
	const cached = cache.get(path);
	if (cached) return Promise.resolve(cached);
	let p = inflight.get(path);
	if (!p) {
		p = api
			.getAudioPeaks(path, null)
			.catch(() => [] as number[])
			.then((peaks) => {
				cache.set(path, peaks);
				inflight.delete(path);
				return peaks;
			});
		inflight.set(path, p);
	}
	return p;
}

/// Returns the peak array for `path`, or null while it's still loading.
export function usePeaks(path: string | null): number[] | null {
	const [peaks, setPeaks] = useState<number[] | null>(() =>
		path ? (cache.get(path) ?? null) : null,
	);
	useEffect(() => {
		if (!path) {
			setPeaks(null);
			return;
		}
		const cached = cache.get(path);
		if (cached) {
			setPeaks(cached);
			return;
		}
		setPeaks(null);
		let cancelled = false;
		void fetchPeaks(path).then((p) => {
			if (!cancelled) setPeaks(p);
		});
		return () => {
			cancelled = true;
		};
	}, [path]);
	return peaks;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Lazily import wavesurfer.js so it ships as its own chunk (build.ts sets
//! `splitting: true`) and stays out of the entry bundle — it's only fetched the
//! first time a Music workspace renders a waveform. Mirrors the lazy-three
//! pattern in `lib/loadModelThumbnailer.ts`.

let modulePromise: Promise<typeof import("wavesurfer.js")> | null = null;

export function loadWavesurfer() {
	if (!modulePromise) {
		modulePromise = import("wavesurfer.js");
	}
	return modulePromise.then((m) => m.default);
}

/// The WaveSurfer instance type, resolved without importing the module eagerly.
export type WaveSurferInstance = InstanceType<
	Awaited<ReturnType<typeof loadWavesurfer>>
>;

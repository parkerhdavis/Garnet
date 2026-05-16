// SPDX-License-Identifier: AGPL-3.0-or-later
//! Lazy loader for the Three.js-based offscreen model thumbnailer. The
//! `three` package and its addon loaders are ~700KB minified, and pulling
//! them into the main bundle would re-introduce the parse-time hit we
//! solved with code-splitting. Going through a dynamic import here defers
//! that cost until the first model tile actually needs a thumbnail.

let modulePromise: Promise<typeof import("./modelThumbnailer")> | null = null;

export function loadModelThumbnailer() {
	if (!modulePromise) {
		modulePromise = import("./modelThumbnailer");
	}
	return modulePromise.then((m) => m.modelThumbnailer);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Frame extraction for video tiles. Uses the same `mediaUrl()` HTTP endpoint
//! the inline `<video>` element does, loads each clip into a hidden video
//! element, seeks to a few seconds in, paints to a canvas, and returns a JPEG
//! data URL. Cached in a module-level Map for the session so revisiting a
//! library page doesn't re-extract.
//!
//! Extraction is throttled: there's a hard concurrency cap so a 60-tile grid
//! of videos doesn't open 60 simultaneous range-fetches against the local
//! media server. New requests queue until a slot frees.
//!
//! Backend-side caching (writing extracted frames to disk so they persist
//! across sessions) is a follow-up — the in-memory cache is enough to keep
//! a working session snappy.

import { mediaUrl } from "@/lib/tauri";

const MAX_CONCURRENT = 3;
const SEEK_SECONDS = 1.0; // where in the clip to grab the frame from
const JPEG_QUALITY = 0.75;

type CacheEntry =
	| { kind: "ok"; dataUrl: string }
	| { kind: "err"; error: string };

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<CacheEntry>>();
const queue: Array<() => void> = [];
let inFlight = 0;

function pump() {
	while (inFlight < MAX_CONCURRENT && queue.length > 0) {
		const task = queue.shift();
		if (!task) break;
		inFlight += 1;
		task();
	}
}

function withSlot<T>(work: () => Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		queue.push(() => {
			work()
				.then(resolve, reject)
				.finally(() => {
					inFlight -= 1;
					pump();
				});
		});
		pump();
	});
}

async function extract(absPath: string): Promise<CacheEntry> {
	const url = await mediaUrl(absPath);
	return await new Promise<CacheEntry>((resolve) => {
		const video = document.createElement("video");
		video.muted = true;
		video.preload = "auto";
		video.playsInline = true;
		video.crossOrigin = "anonymous";
		video.src = url;

		let done = false;
		const finish = (entry: CacheEntry) => {
			if (done) return;
			done = true;
			video.removeAttribute("src");
			video.load();
			resolve(entry);
		};

		const timeout = setTimeout(
			() => finish({ kind: "err", error: "timeout" }),
			15_000,
		);

		video.addEventListener("loadeddata", () => {
			try {
				const dur = video.duration;
				const t = Number.isFinite(dur) && dur > 0 ? Math.min(SEEK_SECONDS, dur / 4) : 0;
				video.currentTime = t;
			} catch (_e) {
				finish({ kind: "err", error: "seek-rejected" });
			}
		});

		video.addEventListener("seeked", () => {
			try {
				const w = video.videoWidth;
				const h = video.videoHeight;
				if (!w || !h) {
					finish({ kind: "err", error: "no-dimensions" });
					return;
				}
				// Downscale the longest edge to 480px so the data URL stays
				// reasonably small. Keeps aspect ratio.
				const maxEdge = 480;
				const scale = Math.min(1, maxEdge / Math.max(w, h));
				const cw = Math.max(1, Math.round(w * scale));
				const ch = Math.max(1, Math.round(h * scale));
				const canvas = document.createElement("canvas");
				canvas.width = cw;
				canvas.height = ch;
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					finish({ kind: "err", error: "no-canvas-ctx" });
					return;
				}
				ctx.drawImage(video, 0, 0, cw, ch);
				const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
				clearTimeout(timeout);
				finish({ kind: "ok", dataUrl });
			} catch (e) {
				finish({ kind: "err", error: `draw-failed: ${String(e)}` });
			}
		});

		video.addEventListener("error", () => {
			const code = video.error?.code;
			finish({ kind: "err", error: `media-error-${code ?? "?"}` });
		});
	});
}

export async function getVideoThumbnail(
	absPath: string,
	mtime: number | null,
): Promise<string | null> {
	const key = `${absPath}|${mtime ?? "?"}`;
	const cached = cache.get(key);
	if (cached) return cached.kind === "ok" ? cached.dataUrl : null;
	const inflight = pending.get(key);
	if (inflight) {
		const entry = await inflight;
		return entry.kind === "ok" ? entry.dataUrl : null;
	}
	const job = withSlot(() => extract(absPath));
	pending.set(key, job);
	try {
		const entry = await job;
		cache.set(key, entry);
		return entry.kind === "ok" ? entry.dataUrl : null;
	} finally {
		pending.delete(key);
	}
}

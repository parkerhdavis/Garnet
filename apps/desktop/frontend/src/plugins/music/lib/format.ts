// SPDX-License-Identifier: AGPL-3.0-or-later
//! Small formatting helpers for the Music Library UI.

import type { MusicTrack } from "@/lib/tauri";

/// Audio-quality fields shared by tracks (and an album's representative track).
type Quality = Pick<
	MusicTrack,
	"format" | "sample_rate" | "bit_depth" | "channels"
>;

/// "Stereo" / "Mono" / "6ch".
export function channelsLabel(ch: number | null | undefined): string | null {
	if (!ch) return null;
	if (ch === 1) return "Mono";
	if (ch === 2) return "Stereo";
	return `${ch}ch`;
}

/// kHz label: 48000 → "48 kHz", 44100 → "44.1 kHz".
function khz(rate: number): string {
	const k = rate / 1000;
	return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

/// Quality chips for an album/track header, e.g. ["FLAC", "24-bit", "48 kHz",
/// "Stereo"]. Omits any field that's missing.
export function qualityChips(q: Quality): string[] {
	const chips: string[] = [];
	if (q.format) chips.push(q.format.toUpperCase());
	if (q.bit_depth) chips.push(`${q.bit_depth}-bit`);
	if (q.sample_rate) chips.push(khz(q.sample_rate));
	const ch = channelsLabel(q.channels);
	if (ch) chips.push(ch);
	return chips;
}

/// True for hi-res audio: deeper than CD bit depth, or above 48 kHz.
export function isHiRes(q: Quality): boolean {
	return (q.bit_depth ?? 0) >= 24 || (q.sample_rate ?? 0) > 48000;
}

/// Compact one-cell quality, e.g. "FLAC 24/48" (format + bit-depth/kHz).
export function qualityShort(q: Quality): string | null {
	if (!q.format) return null;
	const fmt = q.format.toUpperCase();
	if (q.bit_depth && q.sample_rate) {
		return `${fmt} ${q.bit_depth}/${Math.round(q.sample_rate / 1000)}`;
	}
	return fmt;
}

/// Format a track length in seconds as `m:ss` (or `h:mm:ss` past an hour).
export function formatDuration(secs: number | null | undefined): string {
	if (secs == null || !Number.isFinite(secs) || secs < 0) return "—";
	const total = Math.round(secs);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, "0");
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
	return `${m}:${ss}`;
}

/// Compact album subtitle, e.g. "12 tracks · 48 min" (or "· 1,243 min" rolled to
/// hours past 60). `year` is prepended when known.
export function albumSubtitle(
	trackCount: number,
	totalSecs: number,
	year: number | null,
): string {
	const tracks = `${trackCount} ${trackCount === 1 ? "track" : "tracks"}`;
	const mins = Math.round(totalSecs / 60);
	const length =
		mins >= 60 ? `${Math.floor(mins / 60)} hr ${mins % 60} min` : `${mins} min`;
	const parts = [tracks, length];
	return year ? `${year} · ${parts.join(" · ")}` : parts.join(" · ");
}

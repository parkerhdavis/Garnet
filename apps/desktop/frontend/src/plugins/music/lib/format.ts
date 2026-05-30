// SPDX-License-Identifier: AGPL-3.0-or-later
//! Small formatting helpers for the Music Library UI.

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
	const length = mins >= 60 ? `${Math.floor(mins / 60)} hr ${mins % 60} min` : `${mins} min`;
	const parts = [tracks, length];
	return year ? `${year} · ${parts.join(" · ")}` : parts.join(" · ");
}

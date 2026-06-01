// SPDX-License-Identifier: AGPL-3.0-or-later
//! Token substitution for the multi-select "Rename N items…" flow. Mirrors the
//! Automations Rename step's tokens (`{name}`, `{ext}`, `{index}`) so the same
//! mental model carries across the app. Unlike the pipeline step — which emits
//! a stem and appends the converted format — an in-place rename keeps the
//! original extension, so the default pattern is `{name}.{ext}` (a no-op) and
//! `{index}` numbers the batch.

export type RenameToken = { token: string; desc: string };

export const RENAME_TOKENS: RenameToken[] = [
	{ token: "{name}", desc: "original name (no extension)" },
	{ token: "{ext}", desc: "original extension" },
	{ token: "{index}", desc: "position in the batch, from 1" },
];

export const DEFAULT_RENAME_PATTERN = "{name}.{ext}";

/// Split a bare filename into its stem and extension (no leading dot). A
/// leading-dot file (".gitignore") or an extension-less name yields an empty
/// extension and the whole string as the stem.
export function splitName(filename: string): { stem: string; ext: string } {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0) return { stem: filename, ext: "" };
	return { stem: filename.slice(0, dot), ext: filename.slice(dot + 1) };
}

/// Resolve a pattern against one file. `index` is 1-based; `count` sets the
/// zero-pad width (min 2) so `{index}` reads as 01, 02 … for a batch of ten.
/// A trailing dot (from `{ext}` on an extension-less file) is trimmed.
export function applyRenamePattern(
	pattern: string,
	filename: string,
	index: number,
	count: number,
): string {
	const { stem, ext } = splitName(filename);
	const pad = Math.max(2, String(Math.max(count, 1)).length);
	const idx = String(index).padStart(pad, "0");
	return pattern
		.replaceAll("{name}", stem)
		.replaceAll("{ext}", ext)
		.replaceAll("{index}", idx)
		.replace(/\.$/, "");
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Accent-color presets. Each preset is a single OKLCH hue; the theme's
//! primary/accent colors are defined as `oklch(L C var(--garnet-hue))` in
//! styles/index.css, so swapping the hue rotates the whole accent family while
//! keeping lightness/chroma (and the warm-neutral backgrounds) untouched. The
//! `id`s are mirrored by the backend's `set_app_icon` command, which swaps the
//! window icon to a matching pre-generated gem — keep the two lists in sync.

export type AccentPreset = {
	id: string;
	name: string;
	/** OKLCH hue in degrees. */
	hue: number;
};

export const ACCENT_PRESETS: AccentPreset[] = [
	{ id: "garnet", name: "Garnet", hue: 28 },
	{ id: "amber", name: "Amber", hue: 65 },
	{ id: "emerald", name: "Emerald", hue: 150 },
	{ id: "sapphire", name: "Sapphire", hue: 250 },
	{ id: "amethyst", name: "Amethyst", hue: 300 },
	{ id: "rose", name: "Rose", hue: 350 },
];

export const DEFAULT_ACCENT_ID = "garnet";

/** The hue for a preset id, falling back to the default if the id is unknown. */
export function accentHue(id: string): number {
	const preset = ACCENT_PRESETS.find((p) => p.id === id);
	return (preset ?? ACCENT_PRESETS[0]).hue;
}

/** The brand "primary" colour for a preset, for swatches/previews. Mirrors the
 *  dark-theme `--color-primary` (oklch 0.535 / 0.18) at the preset's hue. */
export function accentPrimaryCss(hue: number): string {
	return `oklch(0.535 0.18 ${hue})`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//! Single source of truth for the app's keyboard shortcuts. The Keybinds
//! page renders this list directly; future help overlays or tutorial flows
//! can read from the same data. Keep this in sync with the actual handlers
//! (mostly in App.tsx and AnimationControls).

export type Keybind = {
	/// Display tokens for each key in the chord. Rendered as styled
	/// <kbd> elements separated by "+".
	keys: string[];
	description: string;
};

export type KeybindCategory = {
	title: string;
	hint?: string;
	items: Keybind[];
};

export const KEYBIND_CATEGORIES: KeybindCategory[] = [
	{
		title: "Navigation",
		items: [
			{ keys: ["Alt", "←"], description: "Go back" },
			{ keys: ["Alt", "→"], description: "Go forward" },
			{ keys: ["⌘", "["], description: "Go back (macOS)" },
			{ keys: ["⌘", "]"], description: "Go forward (macOS)" },
			{ keys: ["Esc"], description: "Close detail view, return to library" },
		],
	},
	{
		title: "Selection (library view)",
		items: [
			{ keys: ["Click"], description: "Select asset (replaces any prior selection)" },
			{ keys: ["Ctrl", "Click"], description: "Toggle asset in selection" },
			{ keys: ["Shift", "Click"], description: "Select range from anchor to clicked tile" },
			{ keys: ["Double-click"], description: "Open asset in detail view" },
			{ keys: ["Ctrl", "D"], description: "Deselect all" },
			{ keys: ["Esc"], description: "Deselect all" },
		],
	},
	{
		title: "Animation playback (detail view)",
		items: [
			{ keys: ["Space"], description: "Play / pause" },
			{ keys: [","], description: "Previous frame (pauses playback)" },
			{ keys: ["."], description: "Next frame (pauses playback)" },
		],
		hint: "Scrubbing the timeline also pauses playback.",
	},
	{
		title: "Edit",
		items: [
			{ keys: ["Ctrl", "Z"], description: "Undo" },
			{ keys: ["Ctrl", "Shift", "Z"], description: "Redo" },
			{ keys: ["Ctrl", "Y"], description: "Redo" },
		],
		hint: "On macOS, ⌘ substitutes for Ctrl on every shortcut listed here.",
	},
];

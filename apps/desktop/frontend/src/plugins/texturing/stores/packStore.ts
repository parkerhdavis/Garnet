// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
	ImageInfo,
	ImageWithPreview,
	ChannelSource,
} from "@/plugins/texturing/types";
import { channelSourceToIndex } from "@/plugins/texturing/types";

// --- Shared types ---

type PackSubmodule = "unpack" | "swizzle" | "pack";
type SlotName = "r" | "g" | "b" | "a";

// --- Unpack types ---

interface UnpackChannelPreviews {
	r: string | null;
	g: string | null;
	b: string | null;
	a: string | null;
}

// --- Swizzle types ---

interface SwizzleMapping {
	source: ChannelSource;
	invert: boolean;
}

interface SwizzleMappings {
	r: SwizzleMapping;
	g: SwizzleMapping;
	b: SwizzleMapping;
	a: SwizzleMapping;
}

const SWIZZLE_DEFAULTS: SwizzleMappings = {
	r: { source: "r", invert: false },
	g: { source: "g", invert: false },
	b: { source: "b", invert: false },
	a: { source: "a", invert: false },
};

function isSwizzleIdentity(mappings: SwizzleMappings): boolean {
	return (
		mappings.r.source === "r" &&
		!mappings.r.invert &&
		mappings.g.source === "g" &&
		!mappings.g.invert &&
		mappings.b.source === "b" &&
		!mappings.b.invert &&
		mappings.a.source === "a" &&
		!mappings.a.invert
	);
}

// --- Pack types ---

interface ChannelSlot {
	filePath: string;
	sourceChannel: ChannelSource;
	invert: boolean;
	thumbnail: string;
	info: ImageInfo;
}

interface PresetLabels {
	r: string;
	g: string;
	b: string;
	a: string;
	r_invert: boolean;
	g_invert: boolean;
	b_invert: boolean;
	a_invert: boolean;
}

interface PackingPreset {
	name: string;
	description: string;
	builtin: boolean;
	labels: PresetLabels;
}

// --- Filename matching helpers (inlined; Packi's @/utils/textureDetection is
// not part of Garnet's shared foundation) ---

const ROLE_KEYWORDS: Record<string, string[]> = {
	color: ["color", "albedo", "basecolor", "base_color", "diffuse", "diff"],
	normal: ["normal", "norm", "nrm"],
	roughness: ["roughness", "rough"],
	smoothness: ["smoothness", "smooth", "gloss", "glossiness"],
	metallic: ["metalness", "metallic", "metal"],
	ao: ["ambientocclusion", "ao", "occlusion"],
	displacement: ["displacement", "disp", "height", "heightmap"],
	opacity: ["opacity", "alpha", "transparency", "mask"],
	detail: ["detail", "detailmask", "detail_mask"],
	emissive: ["emissive", "emission", "glow"],
};

function keywordsForLabel(label: string): string[] {
	const lower = label.toLowerCase().replace(/[\s_-]+/g, "");
	for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
		if (
			lower === role ||
			keywords.some((kw) => lower === kw || lower.includes(kw))
		) {
			return keywords;
		}
	}
	return [lower];
}

function matchFilename(filename: string, keywords: string[]): number {
	const lower = filename.toLowerCase();
	const stem = lower.replace(/\.[^.]+$/, "");
	const segments = stem.split(/[_\-.\s]+/);
	for (const keyword of keywords) {
		if (segments.includes(keyword)) return 3;
		if (stem.includes(keyword)) return 2;
	}
	return 0;
}

function findBestMatch(filePaths: string[], label: string): string | null {
	const keywords = keywordsForLabel(label);
	let bestPath: string | null = null;
	let bestScore = 0;
	for (const path of filePaths) {
		const filename = path.split(/[\\/]/).pop() ?? "";
		const score = matchFilename(filename, keywords);
		if (score > bestScore) {
			bestScore = score;
			bestPath = path;
		}
	}
	return bestPath;
}

// --- Store ---

interface PackStoreState {
	activeSubmodule: PackSubmodule;
	setSubmodule: (sub: PackSubmodule) => void;

	// Unpack
	unpackInputPath: string | null;
	unpackInputInfo: ImageInfo | null;
	unpackInputPreview: string | null;
	unpackChannelPreviews: UnpackChannelPreviews;
	unpackLoading: boolean;
	loadUnpackInput: (path: string) => Promise<void>;
	clearUnpackInput: () => void;
	exportUnpackChannel: (
		channel: SlotName,
		outputPath: string,
		format: string,
	) => Promise<void>;

	// Swizzle
	swizzleInputPath: string | null;
	swizzleInputInfo: ImageInfo | null;
	swizzleInputPreview: string | null;
	swizzleResultPreview: string | null;
	swizzleMappings: SwizzleMappings;
	swizzleInputLoading: boolean;
	swizzlePreviewLoading: boolean;
	loadSwizzleInput: (path: string) => Promise<void>;
	clearSwizzleInput: () => void;
	setSwizzleMapping: (channel: SlotName, source: ChannelSource) => void;
	toggleSwizzleInvert: (channel: SlotName) => void;
	regenerateSwizzlePreview: () => void;
	exportSwizzled: (outputPath: string, format: string) => Promise<void>;

	// Pack
	packChannels: {
		r: ChannelSlot | null;
		g: ChannelSlot | null;
		b: ChannelSlot | null;
		a: ChannelSlot | null;
	};
	packLoadingChannels: { r: boolean; g: boolean; b: boolean; a: boolean };
	packPreview: string | null;
	packPreviewLoading: boolean;
	packActivePreset: string | null;
	packPresetLabels: PresetLabels | null;
	packPresets: PackingPreset[];
	packTargetResolution: [number, number] | null;
	setChannel: (slot: SlotName, filePath: string) => Promise<void>;
	clearChannel: (slot: SlotName) => void;
	setSourceChannel: (slot: SlotName, channel: ChannelSource) => void;
	toggleInvert: (slot: SlotName) => void;
	applyPreset: (presetName: string) => void;
	clearPreset: () => void;
	loadPresets: () => Promise<void>;
	regeneratePackPreview: () => void;
	exportPacked: (outputPath: string, format: string) => Promise<void>;
	autoDetectChannels: (filePaths: string[]) => Promise<void>;
}

let swizzleDebounce: ReturnType<typeof setTimeout> | null = null;
let packDebounce: ReturnType<typeof setTimeout> | null = null;

export const usePackStore = create<PackStoreState>((set, get) => ({
	activeSubmodule: "unpack",
	setSubmodule: (sub) => set({ activeSubmodule: sub }),

	// --- Unpack ---

	unpackInputPath: null,
	unpackInputInfo: null,
	unpackInputPreview: null,
	unpackChannelPreviews: { r: null, g: null, b: null, a: null },
	unpackLoading: false,

	loadUnpackInput: async (path) => {
		set({ unpackLoading: true });
		try {
			const [result, channels] = await Promise.all([
				invoke<ImageWithPreview>("load_image_with_preview", {
					path,
					maxPreviewSize: 512,
				}),
				invoke<UnpackChannelPreviews>("unpack_channels", {
					path,
					maxPreviewSize: 512,
				}),
			]);
			set({
				unpackInputPath: path,
				unpackInputInfo: result.info,
				unpackInputPreview: result.preview,
				unpackChannelPreviews: channels,
				unpackLoading: false,
			});
		} catch (err) {
			console.error("Failed to load unpack input:", err);
			set({ unpackLoading: false });
		}
	},

	clearUnpackInput: () => {
		set({
			unpackInputPath: null,
			unpackInputInfo: null,
			unpackInputPreview: null,
			unpackChannelPreviews: { r: null, g: null, b: null, a: null },
		});
	},

	exportUnpackChannel: async (channel, outputPath, format) => {
		const { unpackInputPath } = get();
		if (!unpackInputPath) return;
		const channelIndex = { r: 0, g: 1, b: 2, a: 3 }[channel];
		await invoke("export_unpacked", {
			path: unpackInputPath,
			channel: channelIndex,
			outputPath,
			format,
		});
	},

	// --- Swizzle ---

	swizzleInputPath: null,
	swizzleInputInfo: null,
	swizzleInputPreview: null,
	swizzleResultPreview: null,
	swizzleMappings: { ...SWIZZLE_DEFAULTS },
	swizzleInputLoading: false,
	swizzlePreviewLoading: false,

	loadSwizzleInput: async (path) => {
		set({ swizzleInputLoading: true });
		try {
			const result = await invoke<ImageWithPreview>("load_image_with_preview", {
				path,
				maxPreviewSize: 512,
			});
			set({
				swizzleInputPath: path,
				swizzleInputInfo: result.info,
				swizzleInputPreview: result.preview,
				swizzleResultPreview: null,
				swizzleInputLoading: false,
			});
			get().regenerateSwizzlePreview();
		} catch (err) {
			console.error("Failed to load swizzle input:", err);
			set({ swizzleInputLoading: false });
		}
	},

	clearSwizzleInput: () => {
		set({
			swizzleInputPath: null,
			swizzleInputInfo: null,
			swizzleInputPreview: null,
			swizzleResultPreview: null,
		});
	},

	setSwizzleMapping: (channel, source) => {
		set((s) => ({
			swizzleMappings: {
				...s.swizzleMappings,
				[channel]: { ...s.swizzleMappings[channel], source },
			},
		}));
		get().regenerateSwizzlePreview();
	},

	toggleSwizzleInvert: (channel) => {
		set((s) => ({
			swizzleMappings: {
				...s.swizzleMappings,
				[channel]: {
					...s.swizzleMappings[channel],
					invert: !s.swizzleMappings[channel].invert,
				},
			},
		}));
		get().regenerateSwizzlePreview();
	},

	regenerateSwizzlePreview: () => {
		if (swizzleDebounce) clearTimeout(swizzleDebounce);
		swizzleDebounce = setTimeout(async () => {
			const { swizzleInputPath, swizzleMappings } = get();
			if (!swizzleInputPath) {
				set({ swizzleResultPreview: null, swizzlePreviewLoading: false });
				return;
			}
			if (isSwizzleIdentity(swizzleMappings)) {
				set({ swizzleResultPreview: null, swizzlePreviewLoading: false });
				return;
			}

			set({ swizzlePreviewLoading: true });
			try {
				const result = await invoke<string>("swizzle_channels", {
					path: swizzleInputPath,
					config: {
						r_source: channelSourceToIndex(swizzleMappings.r.source),
						g_source: channelSourceToIndex(swizzleMappings.g.source),
						b_source: channelSourceToIndex(swizzleMappings.b.source),
						a_source: channelSourceToIndex(swizzleMappings.a.source),
						r_invert: swizzleMappings.r.invert,
						g_invert: swizzleMappings.g.invert,
						b_invert: swizzleMappings.b.invert,
						a_invert: swizzleMappings.a.invert,
					},
					maxPreviewSize: 1024,
				});
				set({ swizzleResultPreview: result, swizzlePreviewLoading: false });
			} catch (err) {
				console.error("Swizzle preview failed:", err);
				set({ swizzlePreviewLoading: false });
			}
		}, 300);
	},

	exportSwizzled: async (outputPath, format) => {
		const { swizzleInputPath, swizzleMappings } = get();
		if (!swizzleInputPath) return;
		await invoke("export_swizzled", {
			path: swizzleInputPath,
			config: {
				r_source: channelSourceToIndex(swizzleMappings.r.source),
				g_source: channelSourceToIndex(swizzleMappings.g.source),
				b_source: channelSourceToIndex(swizzleMappings.b.source),
				a_source: channelSourceToIndex(swizzleMappings.a.source),
				r_invert: swizzleMappings.r.invert,
				g_invert: swizzleMappings.g.invert,
				b_invert: swizzleMappings.b.invert,
				a_invert: swizzleMappings.a.invert,
			},
			outputPath,
			format,
		});
	},

	// --- Pack ---

	packChannels: { r: null, g: null, b: null, a: null },
	packLoadingChannels: { r: false, g: false, b: false, a: false },
	packPreview: null,
	packPreviewLoading: false,
	packActivePreset: null,
	packPresetLabels: null,
	packPresets: [],
	packTargetResolution: null,

	setChannel: async (slot, filePath) => {
		set((s) => ({
			packLoadingChannels: { ...s.packLoadingChannels, [slot]: true },
		}));
		try {
			const result = await invoke<ImageWithPreview>("load_image_with_preview", {
				path: filePath,
				maxPreviewSize: 128,
			});

			const { packPresetLabels } = get();
			const invertKey = `${slot}_invert` as keyof PresetLabels;
			const defaultInvert = packPresetLabels
				? Boolean(packPresetLabels[invertKey])
				: false;

			set((s) => ({
				packChannels: {
					...s.packChannels,
					[slot]: {
						filePath,
						sourceChannel: "luminance" as ChannelSource,
						invert: defaultInvert,
						thumbnail: result.preview,
						info: result.info,
					},
				},
				packLoadingChannels: { ...s.packLoadingChannels, [slot]: false },
			}));

			get().regeneratePackPreview();
		} catch (err) {
			console.error(`Failed to load image for channel ${slot}:`, err);
			set((s) => ({
				packLoadingChannels: { ...s.packLoadingChannels, [slot]: false },
			}));
		}
	},

	clearChannel: (slot) => {
		set((s) => ({
			packChannels: { ...s.packChannels, [slot]: null },
		}));
		get().regeneratePackPreview();
	},

	setSourceChannel: (slot, channel) => {
		set((s) => {
			const ch = s.packChannels[slot];
			if (!ch) return s;
			return {
				packChannels: {
					...s.packChannels,
					[slot]: { ...ch, sourceChannel: channel },
				},
			};
		});
		get().regeneratePackPreview();
	},

	toggleInvert: (slot) => {
		set((s) => {
			const ch = s.packChannels[slot];
			if (!ch) return s;
			return {
				packChannels: {
					...s.packChannels,
					[slot]: { ...ch, invert: !ch.invert },
				},
			};
		});
		get().regeneratePackPreview();
	},

	applyPreset: (presetName) => {
		const preset = get().packPresets.find((p) => p.name === presetName);
		if (!preset) return;
		const { packChannels } = get();
		const invertMap = {
			r: preset.labels.r_invert,
			g: preset.labels.g_invert,
			b: preset.labels.b_invert,
			a: preset.labels.a_invert,
		};
		const updatedChannels = { ...packChannels };
		for (const slot of ["r", "g", "b", "a"] as const) {
			const ch = updatedChannels[slot];
			if (ch) {
				updatedChannels[slot] = { ...ch, invert: invertMap[slot] };
			}
		}
		set({
			packActivePreset: presetName,
			packPresetLabels: preset.labels,
			packChannels: updatedChannels,
		});
		get().regeneratePackPreview();
	},

	clearPreset: () => {
		set({ packActivePreset: null, packPresetLabels: null });
	},

	loadPresets: async () => {
		try {
			const builtin = await invoke<PackingPreset[]>("get_builtin_presets");
			const user = await invoke<PackingPreset[]>("load_user_presets");
			set({ packPresets: [...builtin, ...user] });
		} catch (err) {
			console.error("Failed to load presets:", err);
		}
	},

	regeneratePackPreview: () => {
		if (packDebounce) clearTimeout(packDebounce);
		packDebounce = setTimeout(async () => {
			const { packChannels, packTargetResolution } = get();

			const hasSource =
				packChannels.r || packChannels.g || packChannels.b || packChannels.a;
			if (!hasSource) {
				set({ packPreview: null, packPreviewLoading: false });
				return;
			}

			set({ packPreviewLoading: true });

			const makeConfig = (ch: ChannelSlot | null) => {
				if (!ch) return null;
				return {
					path: ch.filePath,
					source_channel: channelSourceToIndex(ch.sourceChannel),
					invert: ch.invert,
				};
			};

			try {
				const preview = await invoke<string>("pack_channels", {
					config: {
						r: makeConfig(packChannels.r),
						g: makeConfig(packChannels.g),
						b: makeConfig(packChannels.b),
						a: makeConfig(packChannels.a),
						target_resolution: packTargetResolution,
					},
					maxPreviewSize: 1024,
				});
				set({ packPreview: preview, packPreviewLoading: false });
			} catch (err) {
				console.error("Failed to pack channels:", err);
				set({ packPreviewLoading: false });
			}
		}, 300);
	},

	exportPacked: async (outputPath, format) => {
		const { packChannels, packTargetResolution } = get();

		const makeConfig = (ch: ChannelSlot | null) => {
			if (!ch) return null;
			return {
				path: ch.filePath,
				source_channel: channelSourceToIndex(ch.sourceChannel),
				invert: ch.invert,
			};
		};

		await invoke("export_packed", {
			config: {
				r: makeConfig(packChannels.r),
				g: makeConfig(packChannels.g),
				b: makeConfig(packChannels.b),
				a: makeConfig(packChannels.a),
				target_resolution: packTargetResolution,
			},
			outputPath,
			format,
		});
	},

	autoDetectChannels: async (filePaths) => {
		const { packPresetLabels, setChannel } = get();
		if (!packPresetLabels) return;

		const usedPaths = new Set<string>();

		for (const slot of ["r", "g", "b", "a"] as const) {
			const label = packPresetLabels[slot];
			if (!label) continue;
			const remaining = filePaths.filter((p) => !usedPaths.has(p));
			const match = findBestMatch(remaining, label);
			if (match) {
				usedPaths.add(match);
				await setChannel(slot, match);
			}
		}
	},
}));

export type {
	PackSubmodule,
	SlotName,
	ChannelSlot,
	PresetLabels,
	PackingPreset,
	SwizzleMapping,
};

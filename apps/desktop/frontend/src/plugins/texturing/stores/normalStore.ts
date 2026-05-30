// SPDX-License-Identifier: AGPL-3.0-or-later
//! State for the texturing "Adjust" surface — the normal-map operations
//! (flip-green, height-to-normal, blend, normalize). General color adjustments
//! (hue/sat/curve/etc.) live in Garnet's base image editor, so only the
//! normal-map ops are ported here. Previews come back as base64 PNG, debounced
//! during slider drags; export writes a file via export_normal_result.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
	ExportConfig,
	ImageInfo,
	ImageWithPreview,
} from "@/plugins/texturing/types";

export type NormalOperation =
	| "flip"
	| "height-to-normal"
	| "blend"
	| "normalize";

const PREVIEW_SIZE = 1024;
const DEBOUNCE_MS = 300;

function extForFormat(format: string): string {
	switch (format) {
		case "png8":
		case "png16":
			return "png";
		case "jpeg":
			return "jpg";
		default:
			return format;
	}
}

type NormalState = {
	inputPath: string | null;
	inputInfo: ImageInfo | null;
	inputPreview: string | null;
	inputLoading: boolean;

	operation: NormalOperation;
	strength: number;
	blendFactor: number;
	secondPath: string | null;
	secondPreview: string | null;

	resultPreview: string | null;
	previewing: boolean;

	loadInput: (path: string) => Promise<void>;
	clearInput: () => void;
	loadSecond: (path: string) => Promise<void>;
	clearSecond: () => void;
	setOperation: (op: NormalOperation) => void;
	setStrength: (v: number) => void;
	setBlendFactor: (v: number) => void;
	regeneratePreview: () => void;
	exportResult: (config: ExportConfig) => Promise<void>;
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export const useNormalStore = create<NormalState>((set, get) => ({
	inputPath: null,
	inputInfo: null,
	inputPreview: null,
	inputLoading: false,
	operation: "flip",
	strength: 1.0,
	blendFactor: 0.5,
	secondPath: null,
	secondPreview: null,
	resultPreview: null,
	previewing: false,

	loadInput: async (path) => {
		set({ inputLoading: true });
		try {
			const res = await invoke<ImageWithPreview>("load_image_with_preview", {
				path,
				maxPreviewSize: PREVIEW_SIZE,
			});
			set({
				inputPath: path,
				inputInfo: res.info,
				inputPreview: res.preview,
				inputLoading: false,
				resultPreview: null,
			});
			get().regeneratePreview();
		} catch (e) {
			console.error("Failed to load normal-map input:", e);
			set({ inputLoading: false });
		}
	},

	clearInput: () =>
		set({
			inputPath: null,
			inputInfo: null,
			inputPreview: null,
			resultPreview: null,
		}),

	loadSecond: async (path) => {
		try {
			const res = await invoke<ImageWithPreview>("load_image_with_preview", {
				path,
				maxPreviewSize: PREVIEW_SIZE,
			});
			set({ secondPath: path, secondPreview: res.preview });
			get().regeneratePreview();
		} catch (e) {
			console.error("Failed to load blend source:", e);
		}
	},

	clearSecond: () => set({ secondPath: null, secondPreview: null }),

	setOperation: (operation) => {
		set({ operation });
		get().regeneratePreview();
	},
	setStrength: (strength) => {
		set({ strength });
		get().regeneratePreview();
	},
	setBlendFactor: (blendFactor) => {
		set({ blendFactor });
		get().regeneratePreview();
	},

	regeneratePreview: () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(async () => {
			const { inputPath, operation, strength, blendFactor, secondPath } = get();
			if (!inputPath) return;
			set({ previewing: true });
			try {
				let preview: string;
				switch (operation) {
					case "flip":
						preview = await invoke<string>("flip_normal_green", {
							path: inputPath,
							maxPreviewSize: PREVIEW_SIZE,
						});
						break;
					case "height-to-normal":
						preview = await invoke<string>("height_to_normal", {
							path: inputPath,
							strength,
							maxPreviewSize: PREVIEW_SIZE,
						});
						break;
					case "blend":
						if (!secondPath) {
							set({ previewing: false, resultPreview: null });
							return;
						}
						preview = await invoke<string>("blend_normals", {
							pathA: inputPath,
							pathB: secondPath,
							blendFactor,
							maxPreviewSize: PREVIEW_SIZE,
						});
						break;
					default:
						preview = await invoke<string>("normalize_map", {
							path: inputPath,
							maxPreviewSize: PREVIEW_SIZE,
						});
						break;
				}
				set({ resultPreview: preview, previewing: false });
			} catch (e) {
				console.error("Normal-map preview failed:", e);
				set({ previewing: false });
			}
		}, DEBOUNCE_MS);
	},

	exportResult: async (config) => {
		const { inputPath, operation, strength, blendFactor, secondPath } = get();
		if (!inputPath) return;
		const outputPath = `${config.directory}/${config.filename}.${extForFormat(config.format)}`;
		await invoke("export_normal_result", {
			operation,
			path: inputPath,
			outputPath,
			format: config.format,
			strength: operation === "height-to-normal" ? strength : null,
			secondPath: operation === "blend" ? secondPath : null,
			blendFactor: operation === "blend" ? blendFactor : null,
		});
	},
}));

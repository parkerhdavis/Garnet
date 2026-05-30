// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo, ImageWithPreview } from "@/plugins/texturing/types";

type SizeSubmodule = "info" | "vram" | "mipchain";

interface SizeStoreState {
	activeSubmodule: SizeSubmodule;
	setSubmodule: (sub: SizeSubmodule) => void;

	inputPath: string | null;
	inputInfo: ImageInfo | null;
	inputPreview: string | null;
	inputLoading: boolean;

	loadInput: (path: string) => Promise<void>;
	clearInput: () => void;
}

export type { SizeSubmodule };

export const useSizeStore = create<SizeStoreState>((set) => ({
	activeSubmodule: "info",
	setSubmodule: (sub) => set({ activeSubmodule: sub }),

	inputPath: null,
	inputInfo: null,
	inputPreview: null,
	inputLoading: false,

	loadInput: async (path) => {
		set({ inputLoading: true });
		try {
			const result = await invoke<ImageWithPreview>("load_image_with_preview", { path, maxPreviewSize: 1024 });
			set({ inputPath: path, inputInfo: result.info, inputPreview: result.preview, inputLoading: false });
		} catch (err) {
			console.error("Failed to load image:", err);
			set({ inputLoading: false });
		}
	},

	clearInput: () => set({
		inputPath: null,
		inputInfo: null,
		inputPreview: null,
	}),
}));

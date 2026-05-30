// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

type PreviewSubmodule = "2d" | "3d";

interface PreviewStoreState {
	activeSubmodule: PreviewSubmodule;
	setSubmodule: (sub: PreviewSubmodule) => void;

	// Path tracking for active file indicators in Sidebar
	tilingInputPath: string | null;
	setTilingInputPath: (path: string | null) => void;
	materialTexturePaths: Record<string, string | null>;
	setMaterialTexturePath: (slot: string, path: string | null) => void;
}

export type { PreviewSubmodule };

export const usePreviewStore = create<PreviewStoreState>((set) => ({
	activeSubmodule: "2d",
	setSubmodule: (sub) => set({ activeSubmodule: sub }),

	tilingInputPath: null,
	setTilingInputPath: (path) => set({ tilingInputPath: path }),

	materialTexturePaths: {},
	setMaterialTexturePath: (slot, path) =>
		set((state) => ({
			materialTexturePaths: { ...state.materialTexturePaths, [slot]: path },
		})),
}));

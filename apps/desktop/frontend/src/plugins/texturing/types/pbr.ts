// SPDX-License-Identifier: AGPL-3.0-or-later
export type GeometryType = "plane" | "cube" | "sphere" | "cylinder" | "torus" | "custom";
export type NormalType = "opengl" | "directx";

export const MAP_KEYS = [
	"color",
	"normal",
	"roughness",
	"metalness",
	"ambientocclusion",
	"displacement",
	"opacity",
] as const;

export type MapKey = (typeof MAP_KEYS)[number];

export interface PBRSceneConfig {
	geometry: GeometryType;
	geometrySubdivisions: number;
	environment: string;
	normalType: NormalType;
	normalScale: number;
	displacementScale: number;
	tilingScale: number;
	clayRender: boolean;
	textures: Record<MapKey, string | null>;
	/** Data URL of a custom mesh file (OBJ/GLB/GLTF) for "custom" geometry */
	customMeshUrl?: string;
}

export interface PBRSceneStatus {
	ready: boolean;
	captureViewport: () => string | null;
}

/** Shared imperative handle for preview panels that support viewport export. */
export interface PreviewPanelHandle {
	captureViewport: () => string | null;
}

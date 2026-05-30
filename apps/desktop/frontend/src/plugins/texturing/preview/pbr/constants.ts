// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from "three";
import type {
	GeometryType,
	MapKey,
	NormalType,
} from "@/plugins/texturing/types/pbr";

/** Maps our texture slot keys to Three.js MeshPhysicalMaterial property names */
export const MAP_NAMES: Record<MapKey, string> = {
	color: "map",
	normal: "normalMap",
	roughness: "roughnessMap",
	displacement: "displacementMap",
	metalness: "metalnessMap",
	opacity: "alphaMap",
	ambientocclusion: "aoMap",
};

/** Normal map Y-axis direction per convention */
export const NORMAL_MAP_TYPE: Record<NormalType, THREE.Vector2> = {
	opengl: new THREE.Vector2(1, 1),
	directx: new THREE.Vector2(1, -1),
};

/** Material property overrides when a map IS loaded */
export const MAP_ACTIVE_SETTINGS: Record<MapKey, [string, unknown] | null> = {
	color: ["color", new THREE.Color(0xffffff)],
	normal: null,
	roughness: ["roughness", 1],
	displacement: null,
	metalness: ["metalness", 1],
	opacity: ["opacity", 1],
	ambientocclusion: null,
};

/** Material property overrides when a map is NOT loaded (sensible defaults) */
export const MAP_INACTIVE_SETTINGS: Record<MapKey, [string, unknown] | null> = {
	color: ["color", new THREE.Color(0xdddddd)],
	normal: null,
	roughness: ["roughness", 0.5],
	displacement: null,
	metalness: ["metalness", 0],
	opacity: ["opacity", 1],
	ambientocclusion: null,
};

/** Color space per map — color is sRGB, everything else linear */
export const MAP_COLOR_SPACE: Record<MapKey, THREE.ColorSpace> = {
	color: THREE.SRGBColorSpace,
	normal: THREE.LinearSRGBColorSpace,
	roughness: THREE.LinearSRGBColorSpace,
	displacement: THREE.LinearSRGBColorSpace,
	metalness: THREE.LinearSRGBColorSpace,
	opacity: THREE.LinearSRGBColorSpace,
	ambientocclusion: THREE.LinearSRGBColorSpace,
};

/** UV tiling ratio adjustment per geometry type */
export const TILING_RATIO_FACTOR: Record<GeometryType, number> = {
	plane: 1,
	cube: 1,
	cylinder: 1 / Math.PI,
	sphere: 0.5,
	torus: 0.5,
	custom: 1,
};

/** Geometry dropdown options */
export const GEOMETRY_OPTIONS: { value: GeometryType; label: string }[] = [
	{ value: "plane", label: "Plane" },
	{ value: "cube", label: "Cube" },
	{ value: "sphere", label: "Sphere" },
	{ value: "cylinder", label: "Cylinder" },
	{ value: "torus", label: "Torus" },
	{ value: "custom", label: "Custom Mesh" },
];

/** Texture map slot definitions for the UI */
export const MAP_SLOTS = [
	{
		key: "color",
		label: "Color (Albedo)",
		keywords: ["color", "albedo", "basecolor", "base_color", "diffuse"],
	},
	{ key: "normal", label: "Normal Map", keywords: ["normal", "norm", "nrm"] },
	{ key: "roughness", label: "Roughness", keywords: ["roughness", "rough"] },
	{
		key: "metalness",
		label: "Metalness",
		keywords: ["metalness", "metallic", "metal"],
	},
	{
		key: "ambientocclusion",
		label: "Ambient Occlusion",
		keywords: ["ambientocclusion", "ao", "occlusion"],
	},
	{
		key: "displacement",
		label: "Displacement",
		keywords: ["displacement", "disp", "height"],
	},
	{
		key: "opacity",
		label: "Opacity",
		keywords: ["opacity", "alpha", "transparency"],
	},
] as const;

/** Detect normal map convention from filename */
export function detectNormalType(filename: string): NormalType | null {
	const lower = filename.toLowerCase();
	// Full word match (highest confidence)
	if (lower.includes("directx")) return "directx";
	if (lower.includes("opengl")) return "opengl";
	// Abbreviation match
	if (lower.includes("dx")) return "directx";
	if (lower.includes("gl")) return "opengl";
	return null;
}

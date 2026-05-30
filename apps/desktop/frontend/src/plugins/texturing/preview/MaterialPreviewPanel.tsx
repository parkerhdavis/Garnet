// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	useRef,
	useState,
	useCallback,
	useMemo,
	forwardRef,
	useImperativeHandle,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { usePreviewStore } from "@/plugins/texturing/stores/previewStore";
import DropZone from "@/plugins/texturing/ui/DropZone";
import { LuWand, LuUpload } from "react-icons/lu";
import type { ImageInfo, ImageWithPreview } from "@/plugins/texturing/types";
import type {
	GeometryType,
	MapKey,
	NormalType,
	PreviewPanelHandle,
} from "@/plugins/texturing/types/pbr";
import { MAP_KEYS } from "@/plugins/texturing/types/pbr";
import { useThreeScene } from "@/plugins/texturing/hooks/useThreeScene";
import {
	GEOMETRY_OPTIONS,
	MAP_SLOTS,
} from "@/plugins/texturing/preview/pbr/constants";

interface TextureSlot {
	path: string | null;
	preview: string | null;
	info: ImageInfo | null;
}

const emptySlot: TextureSlot = { path: null, preview: null, info: null };

const EMPTY_TEXTURES: Record<MapKey, string | null> = Object.fromEntries(
	MAP_KEYS.map((k) => [k, null]),
) as Record<MapKey, string | null>;

const MaterialPreviewPanel = forwardRef<PreviewPanelHandle>(
	function MaterialPreviewPanel(_props, ref) {
		const canvasRef = useRef<HTMLDivElement>(null);

		// Texture slot UI state (thumbnails, paths, info)
		const [textures, setTextures] = useState<Record<MapKey, TextureSlot>>(
			Object.fromEntries(MAP_KEYS.map((k) => [k, { ...emptySlot }])) as Record<
				MapKey,
				TextureSlot
			>,
		);

		// Full-res data URLs sent to Three.js
		const [textureDataUrls, setTextureDataUrls] = useState<
			Record<MapKey, string | null>
		>({ ...EMPTY_TEXTURES });

		// Scene controls
		const [geometry, setGeometry] = useState<GeometryType>("sphere");
		const [normalType, setNormalType] = useState<NormalType>("opengl");
		const [normalScale, setNormalScale] = useState(1.0);
		const [displacementScale, setDisplacementScale] = useState(0.01);
		const [tilingScale, setTilingScale] = useState(1.0);
		const [clayRender, setClayRender] = useState(false);
		const [customMeshUrl, setCustomMeshUrl] = useState<string | undefined>(
			undefined,
		);
		const [customMeshName, setCustomMeshName] = useState<string | null>(null);

		// Loading states
		const [loadingSlots, setLoadingSlots] = useState<Set<MapKey>>(new Set());
		const [autofilling, setAutofilling] = useState(false);
		// Input directory to scan for autofill. Sourced via the folder picker since
		// Garnet has no settings store; without a chosen directory autofill is disabled.
		const [inputDir, setInputDir] = useState<string | null>(null);

		// Preview store for active file indicators
		const setMaterialTexturePath = usePreviewStore(
			(s) => s.setMaterialTexturePath,
		);

		// Build scene config for the Three.js hook
		const sceneConfig = useMemo(
			() => ({
				geometry,
				geometrySubdivisions: 500,
				// Fixed procedural lighting (RoomEnvironment); kept on the config to
				// satisfy the type, no longer user-selectable.
				environment: "studio",
				normalType,
				normalScale,
				displacementScale,
				tilingScale,
				clayRender,
				textures: textureDataUrls,
				customMeshUrl,
			}),
			[
				geometry,
				normalType,
				normalScale,
				displacementScale,
				tilingScale,
				clayRender,
				textureDataUrls,
				customMeshUrl,
			],
		);

		const { ready, captureViewport } = useThreeScene(canvasRef, sceneConfig);

		useImperativeHandle(ref, () => ({ captureViewport }), [captureViewport]);

		// Load a texture into a slot
		const loadTexture = useCallback(
			async (slot: MapKey, path: string) => {
				setLoadingSlots((prev) => new Set(prev).add(slot));
				try {
					const [result, fullRes] = await Promise.all([
						invoke<ImageWithPreview>("load_image_with_preview", {
							path,
							maxPreviewSize: 128,
						}),
						invoke<string>("load_image_as_base64", {
							path,
							maxPreviewSize: 2048,
						}),
					]);

					setTextures((prev) => ({
						...prev,
						[slot]: { path, preview: result.preview, info: result.info },
					}));
					setMaterialTexturePath(slot, path);

					const dataUrl = `data:image/png;base64,${fullRes}`;
					setTextureDataUrls((prev) => ({ ...prev, [slot]: dataUrl }));
				} catch (err) {
					console.error(`Failed to load texture for ${slot}:`, err);
				}
				setLoadingSlots((prev) => {
					const next = new Set(prev);
					next.delete(slot);
					return next;
				});
			},
			[setMaterialTexturePath],
		);

		// Clear a texture slot
		const clearTexture = useCallback(
			(slot: MapKey) => {
				setTextures((prev) => ({ ...prev, [slot]: { ...emptySlot } }));
				setMaterialTexturePath(slot, null);
				setTextureDataUrls((prev) => ({ ...prev, [slot]: null }));
			},
			[setMaterialTexturePath],
		);

		// Find the best normal map match for the current normalType setting
		const findBestNormal = useCallback(
			(files: string[], currentNormalType: NormalType): string | null => {
				const normalSlot = MAP_SLOTS.find((m) => m.key === "normal")!;
				const candidates = files.filter((filePath) => {
					const filename = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
					return normalSlot.keywords.some((kw) => filename.includes(kw));
				});

				if (candidates.length === 0) return null;

				const getFilename = (path: string) =>
					path.split(/[/\\]/).pop()?.toLowerCase() ?? "";

				// 1. Look for "DirectX" / "OpenGL" full word in filename matching current type
				const fullWord = currentNormalType === "directx" ? "directx" : "opengl";
				const fullWordMatch = candidates.find((p) =>
					getFilename(p).includes(fullWord),
				);
				if (fullWordMatch) return fullWordMatch;

				// 2. Look for "DX" / "GL" abbreviation in filename matching current type
				const abbrev = currentNormalType === "directx" ? "dx" : "gl";
				const abbrevMatch = candidates.find((p) =>
					getFilename(p).includes(abbrev),
				);
				if (abbrevMatch) return abbrevMatch;

				// 3. If only one normal file, use it
				if (candidates.length === 1) return candidates[0];

				// 4. Multiple files, none matched — use first alphabetically
				candidates.sort();
				return candidates[0];
			},
			[],
		);

		// Autofill: pick a directory, then scan it for files matching each slot's keywords
		const handleAutofill = useCallback(async () => {
			setAutofilling(true);
			try {
				let dir = inputDir;
				if (!dir) {
					const picked = await open({ directory: true });
					if (typeof picked !== "string") {
						setAutofilling(false);
						return;
					}
					dir = picked;
					setInputDir(dir);
				}

				const files = await invoke<string[]>("list_image_files", { dir });
				const loads: Promise<void>[] = [];
				for (const slot of MAP_SLOTS) {
					if (textures[slot.key].path) continue;

					if (slot.key === "normal") {
						const match = findBestNormal(files, normalType);
						if (match) {
							loads.push(loadTexture("normal", match));
						}
					} else {
						const match = files.find((filePath) => {
							const filename =
								filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
							return slot.keywords.some((kw) => filename.includes(kw));
						});
						if (match) {
							loads.push(loadTexture(slot.key, match));
						}
					}
				}
				await Promise.all(loads);
			} catch (err) {
				console.error("Autofill failed:", err);
			}
			setAutofilling(false);
		}, [inputDir, textures, loadTexture, normalType, findBestNormal]);

		return (
			<div className="flex flex-1 min-w-0">
				{/* Controls */}
				<div className="w-72 shrink-0 flex flex-col border-r border-base-300 overflow-y-auto">
					{/* Header */}
					<div className="px-3 pt-3 pb-2 border-b border-base-300 shrink-0">
						<div className="text-sm font-semibold text-base-content">
							3D Material Preview
						</div>
						<div className="text-xs text-base-content/40 mt-0.5 leading-snug">
							Preview PBR materials on 3D geometry with image-based lighting.
						</div>
					</div>

					{/* Texture inputs */}
					<div className="p-3 space-y-2 border-b border-base-300">
						<div className="flex items-center justify-between">
							<label className="text-xs font-semibold text-base-content/50">
								Texture Maps
							</label>
							<button
								type="button"
								onClick={handleAutofill}
								disabled={autofilling}
								className="btn btn-ghost btn-xs h-6 min-h-0 px-2 gap-1"
								title="Pick a directory to auto-detect textures by filename"
							>
								{autofilling ? (
									<span className="loading loading-spinner loading-xs" />
								) : (
									<LuWand size={12} />
								)}
								<span className="text-xs">Autofill</span>
							</button>
						</div>
						{MAP_SLOTS.map((slot) => (
							<div key={slot.key}>
								<label className="text-xs text-base-content/50 mb-0.5 block">
									{slot.label}
								</label>
								<DropZone
									label={`Drop ${slot.label.toLowerCase()}`}
									filePath={textures[slot.key].path}
									thumbnail={textures[slot.key].preview}
									onFilePicked={(path) => loadTexture(slot.key, path)}
									onClear={() => clearTexture(slot.key)}
									loading={loadingSlots.has(slot.key)}
									compact
								/>
							</div>
						))}
					</div>

					{/* Scene controls */}
					<div className="p-3 space-y-3">
						<label className="text-xs font-semibold text-base-content/50 block">
							Scene
						</label>

						{/* Geometry */}
						<div title="3D shape to render the material on">
							<label className="text-xs text-base-content/50 mb-0.5 block">
								Geometry
							</label>
							<select
								value={geometry}
								onChange={(e) => setGeometry(e.target.value as GeometryType)}
								className="select select-xs select-bordered w-full"
							>
								{GEOMETRY_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
							{geometry === "custom" && (
								<div className="flex items-center gap-1 mt-1">
									<button
										type="button"
										onClick={async () => {
											const result = await open({
												filters: [
													{
														name: "3D Models",
														extensions: ["obj", "glb", "gltf"],
													},
												],
											});
											if (!result) return;
											const path = result as string;
											const filename = path.split(/[\\/]/).pop() ?? path;
											try {
												const bytes = await readFile(path);
												const ext =
													filename.split(".").pop()?.toLowerCase() ?? "";
												const mime =
													ext === "glb"
														? "model/gltf-binary"
														: ext === "gltf"
															? "model/gltf+json"
															: "text/plain";
												const blob = new Blob([bytes], { type: mime });
												const url = URL.createObjectURL(blob);
												setCustomMeshUrl(url);
												setCustomMeshName(filename);
											} catch (err) {
												console.error("Failed to load mesh:", err);
											}
										}}
										className="btn btn-xs btn-ghost h-6 min-h-0 px-2 gap-1 flex-1"
									>
										<LuUpload size={12} />
										<span className="truncate text-xs">
											{customMeshName ?? "Load mesh..."}
										</span>
									</button>
								</div>
							)}
						</div>

						{/* Normal type */}
						<div title="Normal map convention: OpenGL (Y+) or DirectX (Y-)">
							<label className="text-xs text-base-content/50 mb-0.5 block">
								Normal Map Type
							</label>
							<select
								value={normalType}
								onChange={(e) => setNormalType(e.target.value as NormalType)}
								className="select select-xs select-bordered w-full"
							>
								<option value="opengl">OpenGL</option>
								<option value="directx">DirectX</option>
							</select>
						</div>

						{/* Normal scale */}
						<div title="Strength of the normal map effect">
							<label className="text-xs text-base-content/50 mb-0.5 block">
								Normal Scale: {normalScale.toFixed(2)}
							</label>
							<input
								type="range"
								min="0"
								max="5"
								step="0.05"
								value={normalScale}
								onChange={(e) =>
									setNormalScale(Number.parseFloat(e.target.value))
								}
								className="range range-primary range-xs w-full"
							/>
						</div>

						{/* Displacement scale */}
						<div title="Strength of displacement mapping (vertex offset)">
							<label className="text-xs text-base-content/50 mb-0.5 block">
								Displacement Scale: {displacementScale.toFixed(3)}
							</label>
							<input
								type="range"
								min="0"
								max="0.33"
								step="0.005"
								value={displacementScale}
								onChange={(e) =>
									setDisplacementScale(Number.parseFloat(e.target.value))
								}
								className="range range-primary range-xs w-full"
							/>
						</div>

						{/* Tiling scale */}
						<div title="UV repeat factor for the texture">
							<label className="text-xs text-base-content/50 mb-0.5 block">
								Tiling Scale: {tilingScale.toFixed(1)}
							</label>
							<input
								type="range"
								min="0.1"
								max="10"
								step="0.1"
								value={tilingScale}
								onChange={(e) =>
									setTilingScale(Number.parseFloat(e.target.value))
								}
								className="range range-primary range-xs w-full"
							/>
						</div>

						{/* Clay render */}
						<label
							className="flex items-center gap-2 cursor-pointer"
							title="Disable color map to inspect shape and lighting only"
						>
							<input
								type="checkbox"
								checked={clayRender}
								onChange={(e) => setClayRender(e.target.checked)}
								className="checkbox checkbox-xs checkbox-primary"
							/>
							<span className="text-xs text-base-content/60">Clay Render</span>
						</label>
					</div>
				</div>

				{/* 3D Preview — direct Three.js canvas */}
				<div className="flex-1 min-w-0 relative bg-[#1a1a2e]">
					<div ref={canvasRef} className="w-full h-full" />
					{!ready && (
						<div className="absolute inset-0 flex items-center justify-center bg-base-100/40">
							<span className="loading loading-spinner loading-lg text-primary" />
						</div>
					)}
				</div>
			</div>
		);
	},
);

export default MaterialPreviewPanel;

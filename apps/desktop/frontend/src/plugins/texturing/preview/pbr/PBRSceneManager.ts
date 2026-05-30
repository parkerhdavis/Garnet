// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { MapKey, PBRSceneConfig } from "@/plugins/texturing/types/pbr";
import { MAP_KEYS } from "@/plugins/texturing/types/pbr";
import {
	MAP_NAMES,
	MAP_COLOR_SPACE,
	MAP_ACTIVE_SETTINGS,
	MAP_INACTIVE_SETTINGS,
	NORMAL_MAP_TYPE,
	TILING_RATIO_FACTOR,
} from "./constants";

export class PBRSceneManager {
	private scene: THREE.Scene;
	private camera: THREE.PerspectiveCamera;
	private renderer: THREE.WebGLRenderer;
	private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
	private controls: OrbitControls;
	private textureLoader: THREE.TextureLoader;
	private envRT: THREE.WebGLRenderTarget | null = null;
	private animationId: number | null = null;
	private currentConfig: PBRSceneConfig | null = null;
	private container: HTMLDivElement;
	private onReady: () => void;

	constructor(container: HTMLDivElement, onReady: () => void) {
		this.container = container;
		this.onReady = onReady;

		// Scene
		this.scene = new THREE.Scene();

		// Camera
		this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
		this.camera.position.z = 2;
		this.camera.position.y = 1;

		// Renderer
		this.renderer = new THREE.WebGLRenderer({
			antialias: true,
			preserveDrawingBuffer: true,
		});
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		container.appendChild(this.renderer.domElement);

		// Mesh with default plane geometry
		const material = new THREE.MeshPhysicalMaterial();
		this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), material);
		this.scene.add(this.mesh);

		// Controls
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;

		// Loaders
		this.textureLoader = new THREE.TextureLoader();

		// Procedural studio lighting (Three's RoomEnvironment) — no HDRI files to
		// ship. Matches Garnet's model viewer (Live3DPreview).
		this.setupEnvironment();

		// Initial size
		this.resize();

		// Environment is ready synchronously; signal immediately.
		this.onReady();

		// Start animation loop
		this.animate();
	}

	/** Build a pre-filtered environment from Three's procedural RoomEnvironment
	 *  and use it for image-based lighting + reflections. Background stays clear
	 *  so the container's neutral backdrop shows through. */
	private setupEnvironment(): void {
		const pmrem = new THREE.PMREMGenerator(this.renderer);
		this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
		this.scene.environment = this.envRT.texture;
		pmrem.dispose();
	}

	updateConfig(newConfig: PBRSceneConfig): void {
		const oldConfig = this.currentConfig;
		this.currentConfig = newConfig;

		if (!oldConfig) {
			// First config — apply everything. Lighting is the fixed procedural
			// RoomEnvironment set up in the constructor.
			this.updateGeometry(newConfig);
			this.updateAllTextures(newConfig);
			this.updateNormalScale(newConfig);
			this.updateDisplacement(newConfig);
			return;
		}

		if (
			oldConfig.geometry !== newConfig.geometry ||
			oldConfig.geometrySubdivisions !== newConfig.geometrySubdivisions ||
			oldConfig.customMeshUrl !== newConfig.customMeshUrl
		) {
			this.updateGeometry(newConfig);
		}

		// Check each texture slot + clay render toggle
		const texturesChanged = MAP_KEYS.some(
			(k) => oldConfig.textures[k] !== newConfig.textures[k],
		);
		const clayChanged = oldConfig.clayRender !== newConfig.clayRender;
		if (texturesChanged || clayChanged) {
			this.updateAllTextures(newConfig, oldConfig);
		}

		// Tiling or geometry change requires re-applying UV repeat on existing textures
		if (
			oldConfig.tilingScale !== newConfig.tilingScale ||
			oldConfig.geometry !== newConfig.geometry
		) {
			this.updateTiling(newConfig);
		}

		if (
			oldConfig.normalType !== newConfig.normalType ||
			oldConfig.normalScale !== newConfig.normalScale
		) {
			this.updateNormalScale(newConfig);
		}

		if (oldConfig.displacementScale !== newConfig.displacementScale) {
			this.updateDisplacement(newConfig);
		}
	}

	resize(): void {
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w === 0 || h === 0) return;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	}

	/** Render one frame and capture the viewport as a base64 PNG (no data: prefix). */
	captureViewport(): string {
		this.renderer.render(this.scene, this.camera);
		const dataUrl = this.renderer.domElement.toDataURL("image/png");
		return dataUrl.replace(/^data:image\/png;base64,/, "");
	}

	dispose(): void {
		if (this.animationId !== null) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		this.controls.dispose();

		// Dispose all textures on the material
		const mat = this.mesh.material;
		for (const key of MAP_KEYS) {
			const propName = MAP_NAMES[key];
			const tex = (mat as unknown as Record<string, unknown>)[
				propName
			] as THREE.Texture | null;
			tex?.dispose();
		}
		mat.dispose();
		this.mesh.geometry.dispose();

		// Dispose the procedural environment render target.
		this.scene.environment = null;
		this.envRT?.dispose();
		this.envRT = null;

		this.renderer.dispose();
		this.renderer.domElement.remove();
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private animate = (): void => {
		this.animationId = requestAnimationFrame(this.animate);
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	};

	private updateGeometry(config: PBRSceneConfig): void {
		const subs = config.geometrySubdivisions;
		let geometry: THREE.BufferGeometry;
		let side: THREE.Side = THREE.FrontSide;
		let rx = 0;
		let ry = 0;
		const rz = 0;

		if (config.geometry === "custom" && config.customMeshUrl) {
			this.loadCustomMesh(config.customMeshUrl);
			return;
		}

		switch (config.geometry) {
			case "cube":
				geometry = new THREE.BoxGeometry(1, 1, 1, subs, subs, subs);
				break;
			case "cylinder":
				geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, subs, subs, true);
				side = THREE.DoubleSide;
				ry = Math.PI;
				break;
			case "sphere":
				geometry = new THREE.SphereGeometry(0.5, subs, subs);
				break;
			case "torus":
				geometry = new THREE.TorusGeometry(0.5, 0.25, subs, subs);
				rx = 0.5 * Math.PI;
				break;
			default:
				geometry = new THREE.PlaneGeometry(1, 1, subs, subs);
				side = THREE.DoubleSide;
				rx = 1.5 * Math.PI;
				break;
		}

		this.mesh.geometry.dispose();
		this.mesh.geometry = geometry;
		this.mesh.material.side = side;
		this.mesh.rotation.set(rx, ry, rz);
	}

	private loadCustomMesh(url: string): void {
		const isGltf = url.includes(".glb") || url.includes(".gltf");

		if (isGltf) {
			const loader = new GLTFLoader();
			loader.load(url, (gltf) => {
				const meshNode = gltf.scene.getObjectByProperty("type", "Mesh") as
					| THREE.Mesh
					| undefined;
				if (meshNode?.geometry) {
					this.applyCustomGeometry(meshNode.geometry);
				}
			});
		} else {
			// Assume OBJ
			const loader = new OBJLoader();
			loader.load(url, (group) => {
				const meshNode = group.children.find((c) => c instanceof THREE.Mesh) as
					| THREE.Mesh
					| undefined;
				if (meshNode?.geometry) {
					this.applyCustomGeometry(meshNode.geometry);
				}
			});
		}
	}

	private applyCustomGeometry(geometry: THREE.BufferGeometry): void {
		// Normalize the geometry to fit within a unit bounding box
		geometry.computeBoundingBox();
		const box = geometry.boundingBox!;
		const size = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z);
		if (maxDim > 0) {
			geometry.scale(1 / maxDim, 1 / maxDim, 1 / maxDim);
		}
		const center = box
			.getCenter(new THREE.Vector3())
			.multiplyScalar(1 / maxDim);
		geometry.translate(-center.x, -center.y, -center.z);

		// Ensure UVs exist (needed for texturing)
		if (!geometry.attributes.uv) {
			// Basic box projection fallback
			geometry.computeBoundingBox();
			const pos = geometry.attributes.position;
			const uvs = new Float32Array(pos.count * 2);
			for (let i = 0; i < pos.count; i++) {
				uvs[i * 2] = pos.getX(i) + 0.5;
				uvs[i * 2 + 1] = pos.getY(i) + 0.5;
			}
			geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
		}

		this.mesh.geometry.dispose();
		this.mesh.geometry = geometry;
		this.mesh.material.side = THREE.DoubleSide;
		this.mesh.rotation.set(0, 0, 0);
	}

	private updateAllTextures(
		config: PBRSceneConfig,
		oldConfig?: PBRSceneConfig,
	): void {
		const mat = this.mesh.material as unknown as Record<string, unknown>;
		const ratioFactor = TILING_RATIO_FACTOR[config.geometry];

		for (const mapKey of MAP_KEYS) {
			let newUrl = config.textures[mapKey];
			const oldUrl = oldConfig?.textures[mapKey] ?? undefined;

			// Clay render disables the color map
			if (mapKey === "color" && config.clayRender) {
				newUrl = null;
			}

			// Also account for clay render toggling even if the underlying URL didn't change
			const clayToggled =
				mapKey === "color" &&
				oldConfig &&
				oldConfig.clayRender !== config.clayRender;
			if (oldUrl === newUrl && !clayToggled && oldConfig) continue;

			const propName = MAP_NAMES[mapKey];

			// Dispose old texture
			const oldTex = mat[propName] as THREE.Texture | null;
			if (oldTex) {
				oldTex.dispose();
				mat[propName] = null;
			}

			if (newUrl) {
				const texture = this.textureLoader.load(newUrl, (tex) => {
					// Set UV tiling based on texture aspect ratio
					const data = tex.source.data as { width: number; height: number };
					const ratio = (data.width / data.height) * ratioFactor;
					if (ratio > 1) {
						tex.repeat.set(config.tilingScale, config.tilingScale * ratio);
					} else {
						tex.repeat.set(config.tilingScale / ratio, config.tilingScale);
					}
				});
				texture.wrapS = THREE.RepeatWrapping;
				texture.wrapT = THREE.RepeatWrapping;
				texture.colorSpace = MAP_COLOR_SPACE[mapKey];

				mat[propName] = texture;

				// Apply active settings (e.g. set color to white so it doesn't tint)
				const active = MAP_ACTIVE_SETTINGS[mapKey];
				if (active) {
					mat[active[0]] = active[1];
				}
				// Enable transparency only when an opacity map is present
				if (mapKey === "opacity") {
					this.mesh.material.transparent = true;
				}
			} else {
				// Apply inactive defaults
				const inactive = MAP_INACTIVE_SETTINGS[mapKey];
				if (inactive) {
					mat[inactive[0]] = inactive[1];
				}
				if (mapKey === "opacity") {
					this.mesh.material.transparent = false;
				}
			}

			mat.needsUpdate = true;
		}
	}

	private updateTiling(config: PBRSceneConfig): void {
		const mat = this.mesh.material as unknown as Record<string, unknown>;
		const ratioFactor = TILING_RATIO_FACTOR[config.geometry];

		for (const mapKey of MAP_KEYS) {
			const propName = MAP_NAMES[mapKey];
			const tex = mat[propName] as THREE.Texture | null;
			if (!tex) continue;
			const data = tex.source?.data as
				| { width: number; height: number }
				| undefined;
			if (!data) continue;

			const ratio = (data.width / data.height) * ratioFactor;
			if (ratio > 1) {
				tex.repeat.set(config.tilingScale, config.tilingScale * ratio);
			} else {
				tex.repeat.set(config.tilingScale / ratio, config.tilingScale);
			}
		}
	}

	private updateNormalScale(config: PBRSceneConfig): void {
		const dir = NORMAL_MAP_TYPE[config.normalType];
		this.mesh.material.normalScale = new THREE.Vector2(
			config.normalScale,
			config.normalScale,
		).multiply(dir);
	}

	private updateDisplacement(config: PBRSceneConfig): void {
		this.mesh.material.displacementBias = config.displacementScale / -2;
		this.mesh.material.displacementScale = config.displacementScale;
	}
}

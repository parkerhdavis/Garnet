// SPDX-License-Identifier: AGPL-3.0-or-later
//! Tiny inline Three.js view used as the AssetThumbnail hover preview for
//! renderable 3D models. The animated counterpart to the existing `<video>`
//! hover preview for video files.
//!
//! Trade-offs vs. `ModelPreview`:
//!   - No OrbitControls. Hover previews are passive; the user doesn't
//!     interact with the tile.
//!   - Auto-rotates static models so something is happening even when the
//!     file has no animation clips.
//!   - Auto-plays the first animation clip if present (motion-only files
//!     get the SkeletonHelper fallback for visibility).
//!   - Each hover instantiates its own renderer. There's only ever one
//!     hover preview alive at a time (mouse → one element), so the GPU
//!     cost is bounded; the 600ms hover delay also keeps mouse-flythroughs
//!     from spawning useless renderers.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isMeaningfulClip } from "@/components/ModelPreview";

const MODEL_KINDS = ["gltf", "glb", "obj", "stl", "ply", "fbx"] as const;
type ModelKind = (typeof MODEL_KINDS)[number];

const AUTOROTATE_SPEED = 0.6; // radians/sec for static models

function kindFor(format: string | null): ModelKind | null {
	if (!format) return null;
	const e = format.toLowerCase();
	return (MODEL_KINDS as readonly string[]).includes(e) ? (e as ModelKind) : null;
}

type Props = {
	absPath: string;
	format: string | null;
};

export function Live3DPreview({ absPath, format }: Props) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const kind = kindFor(format);
		if (!kind) return;

		let disposed = false;
		let animationId: number | null = null;
		let renderer: THREE.WebGLRenderer | null = null;
		let mixer: THREE.AnimationMixer | null = null;
		let root: THREE.Object3D | null = null;
		let skeletonHelper: THREE.SkeletonHelper | null = null;
		let envRT: THREE.WebGLRenderTarget | null = null;
		let hasAnimation = false;

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x1a1a1a);
		const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
		const clock = new THREE.Clock();

		renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.0;
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		const canvas = renderer.domElement;
		canvas.style.display = "block";
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		el.appendChild(canvas);

		const pmrem = new THREE.PMREMGenerator(renderer);
		envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
		scene.environment = envRT.texture;
		pmrem.dispose();

		const dir = new THREE.DirectionalLight(0xffffff, 1.2);
		dir.position.set(2, 3, 2);
		scene.add(dir);
		scene.add(new THREE.AmbientLight(0xffffff, 0.15));

		const resize = () => {
			if (!renderer) return;
			const w = el.clientWidth;
			const h = el.clientHeight;
			if (w === 0 || h === 0) return;
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
			renderer.setSize(w, h, false);
		};
		const ro = new ResizeObserver(resize);
		ro.observe(el);
		resize();

		void loadModel(convertFileSrc(absPath), kind).then((object) => {
			if (disposed || !object) return;
			root = object;
			scene.add(root);

			// Same skeleton-settle dance as the thumbnailer + detail
			// viewer — keeps animated FBX from rendering as a blank.
			root.updateMatrixWorld(true);
			let hasMesh = false;
			let hasBones = false;
			root.traverse((c) => {
				if (c instanceof THREE.SkinnedMesh) {
					c.skeleton.pose();
					c.skeleton.update();
				}
				if (
					c instanceof THREE.Mesh ||
					c instanceof THREE.Points ||
					c instanceof THREE.LineSegments
				) {
					if (c.visible !== false) hasMesh = true;
				}
				if (c instanceof THREE.Bone) hasBones = true;
			});
			if (!hasMesh && hasBones) {
				skeletonHelper = new THREE.SkeletonHelper(root);
				scene.add(skeletonHelper);
			}

			const animations = readAnimations(root, kind).filter(isMeaningfulClip);
			if (animations.length > 0) {
				mixer = new THREE.AnimationMixer(root);
				const action = mixer.clipAction(animations[0]);
				action.play();
				mixer.update(0);
				hasAnimation = true;
			}

			frameCamera(root, camera);
		});

		const tick = () => {
			animationId = requestAnimationFrame(tick);
			const dt = clock.getDelta();
			if (mixer) mixer.update(dt);
			if (root && !hasAnimation) {
				// Slow Y-rotation around the model's center so static
				// objects still feel alive in the hover preview.
				root.rotation.y += AUTOROTATE_SPEED * dt;
			}
			if (renderer) renderer.render(scene, camera);
		};
		tick();

		return () => {
			disposed = true;
			ro.disconnect();
			if (animationId !== null) cancelAnimationFrame(animationId);
			mixer?.stopAllAction();
			if (skeletonHelper) {
				scene.remove(skeletonHelper);
				skeletonHelper.dispose();
			}
			if (root) {
				scene.remove(root);
				disposeObject(root);
			}
			if (envRT) envRT.dispose();
			scene.environment = null;
			if (renderer) {
				renderer.dispose();
				if (canvas.parentNode === el) el.removeChild(canvas);
			}
		};
	}, [absPath, format]);

	return <div ref={containerRef} className="absolute inset-0" />;
}

async function loadModel(url: string, kind: ModelKind): Promise<THREE.Object3D | null> {
	try {
		switch (kind) {
			case "gltf":
			case "glb": {
				const loader = new GLTFLoader();
				const gltf = await loader.loadAsync(url);
				return gltf.scene;
			}
			case "obj":
				return await new OBJLoader().loadAsync(url);
			case "fbx":
				return await new FBXLoader().loadAsync(url);
			case "stl": {
				const geom = await new STLLoader().loadAsync(url);
				geom.computeVertexNormals();
				return new THREE.Mesh(
					geom,
					new THREE.MeshStandardMaterial({
						color: 0xb0b0b0,
						metalness: 0.1,
						roughness: 0.6,
					}),
				);
			}
			case "ply": {
				const geom = await new PLYLoader().loadAsync(url);
				geom.computeVertexNormals();
				const hasColor = !!geom.getAttribute("color");
				return new THREE.Mesh(
					geom,
					new THREE.MeshStandardMaterial({
						color: hasColor ? 0xffffff : 0xb0b0b0,
						vertexColors: hasColor,
						metalness: 0.1,
						roughness: 0.6,
					}),
				);
			}
		}
	} catch {
		return null;
	}
}

function readAnimations(object: THREE.Object3D, kind: ModelKind): THREE.AnimationClip[] {
	// GLTFLoader returns `{scene, animations}` — we only have `scene` here, so
	// animations on glTF aren't accessible from the Object3D alone. FBXLoader
	// puts them on the Group itself.
	const animatedRoot = object as unknown as { animations?: THREE.AnimationClip[] };
	if (Array.isArray(animatedRoot.animations) && animatedRoot.animations.length > 0) {
		return animatedRoot.animations;
	}
	// glTF: the loader stores animations on the returned `gltf` object, not on
	// `gltf.scene`. We could re-load via loader.parse but for hover preview
	// the simpler path is to call back from the loader. (Future TODO if we
	// want glTF hover-anims.)
	void kind;
	return [];
}

function frameCamera(object: THREE.Object3D, camera: THREE.PerspectiveCamera): void {
	const box = new THREE.Box3().setFromObject(object);
	object.traverse((c) => {
		if (c instanceof THREE.Bone) {
			const p = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
			if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
				box.expandByPoint(p);
			}
		}
	});
	if (!Number.isFinite(box.min.x) || box.isEmpty()) {
		camera.position.set(0, 0.5, 2);
		camera.lookAt(0, 0, 0);
		camera.updateProjectionMatrix();
		return;
	}
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	const maxDim = Math.max(size.x, size.y, size.z);
	if (maxDim === 0) return;
	const fov = (camera.fov * Math.PI) / 180;
	const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.7;
	const dir = new THREE.Vector3(0.7, 0.5, 1).normalize();
	camera.position.copy(center).addScaledVector(dir, distance);
	camera.near = Math.max(distance / 1000, 0.001);
	camera.far = distance * 100;
	camera.lookAt(center);
	camera.updateProjectionMatrix();
}

function disposeObject(obj: THREE.Object3D): void {
	obj.traverse((child) => {
		if (
			child instanceof THREE.Mesh ||
			child instanceof THREE.Points ||
			child instanceof THREE.LineSegments
		) {
			child.geometry?.dispose?.();
			const mat = child.material;
			if (Array.isArray(mat)) for (const m of mat) disposeMaterial(m);
			else if (mat) disposeMaterial(mat);
		}
	});
}

function disposeMaterial(mat: THREE.Material): void {
	const props = mat as unknown as Record<string, unknown>;
	for (const key of Object.keys(props)) {
		const value = props[key];
		if (value instanceof THREE.Texture) value.dispose();
	}
	mat.dispose();
}

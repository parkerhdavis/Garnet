// SPDX-License-Identifier: AGPL-3.0-or-later
//! Three.js model viewer for the asset detail page. Loads obj/gltf/glb/stl/ply/fbx
//! via Three's addon loaders, frames the camera to the model's bounding box, lights
//! it with a procedural RoomEnvironment IBL, and exposes a small play/pause + clip
//! dropdown overlay when the file ships animations.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { HiPause, HiPlay } from "react-icons/hi2";

type ClipInfo = { name: string; index: number };

type LoadResult = {
	object: THREE.Object3D;
	animations: THREE.AnimationClip[];
};

type ModelKind = "gltf" | "obj" | "stl" | "ply" | "fbx";

function detectKind(url: string): ModelKind | null {
	const m = url.toLowerCase().match(/\.(gltf|glb|obj|stl|ply|fbx)(?:$|\?)/);
	if (!m) return null;
	const ext = m[1];
	if (ext === "gltf" || ext === "glb") return "gltf";
	return ext as ModelKind;
}

export function ModelPreview({ url, format }: { url: string; format: string | null }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const sceneRef = useRef<ModelScene | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [clips, setClips] = useState<ClipInfo[]>([]);
	const [activeClip, setActiveClip] = useState(0);
	const [playing, setPlaying] = useState(true);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		if (!url) return;
		const kind = detectKind(url) ?? (format ? detectKind(`.${format.toLowerCase()}`) : null);
		if (!kind) {
			setError(`Unsupported model format: ${format ?? "unknown"}`);
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		setClips([]);
		setActiveClip(0);
		setPlaying(true);

		const scene = new ModelScene(el);
		sceneRef.current = scene;
		let cancelled = false;

		scene.loadModel(url, kind).then(
			(found) => {
				if (cancelled) return;
				setClips(found);
				setLoading(false);
			},
			(err) => {
				if (cancelled) return;
				setError(String(err?.message ?? err));
				setLoading(false);
			},
		);

		const ro = new ResizeObserver(() => scene.resize());
		ro.observe(el);

		return () => {
			cancelled = true;
			ro.disconnect();
			scene.dispose();
			sceneRef.current = null;
		};
	}, [url, format]);

	useEffect(() => {
		sceneRef.current?.setActiveClip(activeClip);
	}, [activeClip]);

	useEffect(() => {
		sceneRef.current?.setPlaying(playing);
	}, [playing]);

	return (
		<div className="relative w-full h-full">
			<div ref={containerRef} className="absolute inset-0" />
			{loading && !error && (
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs text-base-content/60">
					Loading model…
				</div>
			)}
			{error && (
				<div className="absolute inset-0 flex items-center justify-center p-6">
					<div className="alert alert-error max-w-md text-xs">
						<span>Couldn't load this model: {error}</span>
					</div>
				</div>
			)}
			{clips.length > 0 && !error && (
				<div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-base-100/90 backdrop-blur border border-base-300 rounded-full px-2 py-1 shadow-lg">
					<button
						type="button"
						className="btn btn-xs btn-circle btn-ghost"
						onClick={() => setPlaying((v) => !v)}
						title={playing ? "Pause" : "Play"}
					>
						{playing ? <HiPause className="size-3.5" /> : <HiPlay className="size-3.5" />}
					</button>
					{clips.length > 1 ? (
						<select
							className="select select-xs select-ghost w-40"
							value={activeClip}
							onChange={(e) => setActiveClip(Number(e.target.value))}
						>
							{clips.map((c) => (
								<option key={c.index} value={c.index}>
									{c.name || `Clip ${c.index + 1}`}
								</option>
							))}
						</select>
					) : (
						<span className="text-[11px] text-base-content/70 px-2 truncate max-w-40">
							{clips[0].name || "Clip 1"}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

class ModelScene {
	private container: HTMLDivElement;
	private scene: THREE.Scene;
	private camera: THREE.PerspectiveCamera;
	private renderer: THREE.WebGLRenderer;
	private controls: OrbitControls;
	private clock = new THREE.Clock();
	private animationId: number | null = null;
	private root: THREE.Object3D | null = null;
	private mixer: THREE.AnimationMixer | null = null;
	private clips: THREE.AnimationClip[] = [];
	private action: THREE.AnimationAction | null = null;
	private disposed = false;
	private envRT: THREE.WebGLRenderTarget | null = null;

	constructor(container: HTMLDivElement) {
		this.container = container;

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x1a1a1a);

		this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
		this.camera.position.set(0, 0.5, 2);

		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		const canvas = this.renderer.domElement;
		canvas.style.display = "block";
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		container.appendChild(canvas);

		const pmrem = new THREE.PMREMGenerator(this.renderer);
		this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
		this.scene.environment = this.envRT.texture;
		pmrem.dispose();

		const dir = new THREE.DirectionalLight(0xffffff, 1.2);
		dir.position.set(2, 3, 2);
		this.scene.add(dir);
		this.scene.add(new THREE.AmbientLight(0xffffff, 0.15));

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;

		this.resize();
		this.animate();
	}

	async loadModel(url: string, kind: ModelKind): Promise<ClipInfo[]> {
		const result = await loadByKind(url, kind);
		if (this.disposed) {
			disposeObject(result.object);
			return [];
		}
		this.attachModel(result);
		return result.animations.map((c, i) => ({ name: c.name, index: i }));
	}

	setActiveClip(index: number): void {
		if (!this.mixer || !this.clips[index]) return;
		this.action?.stop();
		this.action = this.mixer.clipAction(this.clips[index]);
		this.action.reset();
		this.action.play();
	}

	setPlaying(playing: boolean): void {
		if (!this.action) return;
		this.action.paused = !playing;
	}

	resize(): void {
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w === 0 || h === 0) return;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h, false);
	}

	dispose(): void {
		this.disposed = true;
		if (this.animationId !== null) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		this.mixer?.stopAllAction();
		this.mixer = null;
		this.action = null;
		this.clips = [];
		if (this.root) {
			this.scene.remove(this.root);
			disposeObject(this.root);
			this.root = null;
		}
		this.controls.dispose();
		if (this.envRT) {
			this.envRT.dispose();
			this.envRT = null;
		}
		this.scene.environment = null;
		this.renderer.dispose();
		if (this.renderer.domElement.parentNode === this.container) {
			this.container.removeChild(this.renderer.domElement);
		}
	}

	private attachModel(result: LoadResult): void {
		this.root = result.object;
		this.scene.add(this.root);

		this.clips = result.animations;
		if (this.clips.length > 0) {
			this.mixer = new THREE.AnimationMixer(this.root);
			this.action = this.mixer.clipAction(this.clips[0]);
			this.action.play();
		}

		this.frameObject(this.root);
	}

	private frameObject(object: THREE.Object3D): void {
		const box = new THREE.Box3().setFromObject(object);
		if (!isFinite(box.min.x) || box.isEmpty()) return;
		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z);
		if (maxDim === 0) return;

		const fov = (this.camera.fov * Math.PI) / 180;
		const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.6;

		const dir = new THREE.Vector3(0.7, 0.5, 1).normalize();
		this.camera.position.copy(center).addScaledVector(dir, distance);
		this.camera.near = Math.max(distance / 1000, 0.001);
		this.camera.far = distance * 100;
		this.camera.updateProjectionMatrix();

		this.controls.target.copy(center);
		this.controls.update();
	}

	private animate = (): void => {
		this.animationId = requestAnimationFrame(this.animate);
		const dt = this.clock.getDelta();
		this.mixer?.update(dt);
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	};
}

async function loadByKind(url: string, kind: ModelKind): Promise<LoadResult> {
	switch (kind) {
		case "gltf": {
			const loader = new GLTFLoader();
			const gltf = await loader.loadAsync(url);
			return { object: gltf.scene, animations: gltf.animations ?? [] };
		}
		case "obj": {
			const loader = new OBJLoader();
			const group = await loader.loadAsync(url);
			return { object: group, animations: [] };
		}
		case "fbx": {
			const loader = new FBXLoader();
			const group = await loader.loadAsync(url);
			return { object: group, animations: group.animations ?? [] };
		}
		case "stl": {
			const loader = new STLLoader();
			const geom = await loader.loadAsync(url);
			geom.computeVertexNormals();
			const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.1, roughness: 0.6 });
			return { object: new THREE.Mesh(geom, mat), animations: [] };
		}
		case "ply": {
			const loader = new PLYLoader();
			const geom = await loader.loadAsync(url);
			geom.computeVertexNormals();
			const hasColor = !!geom.getAttribute("color");
			const mat = new THREE.MeshStandardMaterial({
				color: hasColor ? 0xffffff : 0xb0b0b0,
				vertexColors: hasColor,
				metalness: 0.1,
				roughness: 0.6,
			});
			return { object: new THREE.Mesh(geom, mat), animations: [] };
		}
	}
}

function disposeObject(obj: THREE.Object3D): void {
	obj.traverse((child) => {
		if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
			child.geometry?.dispose?.();
			const mat = child.material;
			if (Array.isArray(mat)) {
				for (const m of mat) disposeMaterial(m);
			} else if (mat) {
				disposeMaterial(mat);
			}
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

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

	const hasAnim = clips.length > 0;

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
			{hasAnim && !error && (
				<AnimationControls
					sceneRef={sceneRef}
					clips={clips}
					activeClip={activeClip}
					setActiveClip={setActiveClip}
					playing={playing}
					setPlaying={setPlaying}
				/>
			)}
		</div>
	);
}

/// Floating pill at the bottom of the viewer: play/pause + clip selector +
/// scrubable timeline + time readout. The timeline indicator and the time
/// text update via refs in a rAF loop — keeping the React tree out of the
/// per-frame path avoids a re-render every animation tick.
/// Three.js animation clips don't carry the original authoring framerate
/// (FBX has it but Three's loader doesn't preserve it; glTF has no FPS
/// concept at all). Display frames against a fixed 30 FPS reference so the
/// frame counter is at least an internally-consistent grid for "step to
/// next moment" navigation; the actual visual playback uses real seconds.
const ASSUMED_FPS = 30;

function AnimationControls({
	sceneRef,
	clips,
	activeClip,
	setActiveClip,
	playing,
	setPlaying,
}: {
	sceneRef: React.MutableRefObject<ModelScene | null>;
	clips: ClipInfo[];
	activeClip: number;
	setActiveClip: (i: number) => void;
	playing: boolean;
	setPlaying: (p: boolean) => void;
}) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const fillRef = useRef<HTMLDivElement | null>(null);
	const handleRef = useRef<HTMLDivElement | null>(null);
	const timeLabelRef = useRef<HTMLSpanElement | null>(null);
	const frameLabelRef = useRef<HTMLSpanElement | null>(null);
	// Whether the user is currently dragging the scrub handle. While
	// dragging, the rAF loop reads from the scene but doesn't update the
	// progress indicator — the pointer handler owns the position.
	const draggingRef = useRef(false);

	// Space toggles play/pause; "," / "." step one reference frame and
	// pause (matches the standard NLE / video player convention). Only
	// active while AnimationControls is mounted — i.e. only when a clip is
	// actually loaded — so the hotkeys don't interfere with the library
	// view or detail views for non-animated assets.
	useEffect(() => {
		function isEditable(target: EventTarget | null): boolean {
			const el = target as HTMLElement | null;
			if (!el) return false;
			const tag = el.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
			return el.isContentEditable;
		}
		const writeLabelsForCurrent = () => {
			const p = sceneRef.current?.getProgress();
			if (!p || p.duration <= 0) return;
			const fraction = p.time / p.duration;
			if (fillRef.current) fillRef.current.style.width = `${fraction * 100}%`;
			if (handleRef.current) handleRef.current.style.left = `${fraction * 100}%`;
			if (timeLabelRef.current) {
				timeLabelRef.current.textContent = `${formatTime(p.time)} / ${formatTime(p.duration)}`;
			}
			if (frameLabelRef.current) {
				frameLabelRef.current.textContent = `f${Math.floor(p.time * ASSUMED_FPS)} / f${Math.floor(p.duration * ASSUMED_FPS)}`;
			}
		};
		function onKey(e: KeyboardEvent) {
			if (isEditable(e.target)) return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (e.key === " " || e.code === "Space") {
				e.preventDefault();
				setPlaying(!playing);
				return;
			}
			if (e.key === ",") {
				e.preventDefault();
				sceneRef.current?.stepFrames(-1, ASSUMED_FPS);
				// Frame-step pauses on the scene side; flip React state
				// to match so the play/pause icon updates.
				setPlaying(false);
				writeLabelsForCurrent();
				return;
			}
			if (e.key === ".") {
				e.preventDefault();
				sceneRef.current?.stepFrames(1, ASSUMED_FPS);
				setPlaying(false);
				writeLabelsForCurrent();
				return;
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [playing, setPlaying, sceneRef]);

	// Per-frame: read the scene's current animation time and project onto
	// the track. Refs only — no setState in the loop.
	useEffect(() => {
		let rafId = 0;
		const tick = () => {
			rafId = requestAnimationFrame(tick);
			if (draggingRef.current) return;
			const p = sceneRef.current?.getProgress();
			if (!p || p.duration <= 0) return;
			const fraction = Math.max(0, Math.min(1, p.time / p.duration));
			updateIndicator(fraction);
			writeLabels(p.time, p.duration);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [sceneRef, activeClip]);

	const writeLabels = (time: number, duration: number) => {
		if (timeLabelRef.current) {
			timeLabelRef.current.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
		}
		if (frameLabelRef.current) {
			frameLabelRef.current.textContent = `f${Math.floor(time * ASSUMED_FPS)} / f${Math.floor(duration * ASSUMED_FPS)}`;
		}
	};

	const updateIndicator = (fraction: number) => {
		const pct = `${fraction * 100}%`;
		if (fillRef.current) fillRef.current.style.width = pct;
		if (handleRef.current) handleRef.current.style.left = pct;
	};

	const fractionFromEvent = (clientX: number): number => {
		const el = trackRef.current;
		if (!el) return 0;
		const rect = el.getBoundingClientRect();
		return (clientX - rect.left) / rect.width;
	};

	const beginScrub = (e: React.PointerEvent) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		draggingRef.current = true;
		// Pause both the scene and the React state so the play/pause icon
		// flips and playback stays paused after release — matches the
		// "clicking the timeline pauses playback" convention.
		setPlaying(false);
		applyScrub(e.clientX);
	};
	const applyScrub = (clientX: number) => {
		const f = Math.max(0, Math.min(1, fractionFromEvent(clientX)));
		sceneRef.current?.seekToFraction(f);
		updateIndicator(f);
		const dur = sceneRef.current?.getProgress()?.duration ?? 0;
		writeLabels(f * dur, dur);
	};
	const onPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0) return;
		beginScrub(e);
	};
	const onPointerMove = (e: React.PointerEvent) => {
		if (!draggingRef.current) return;
		applyScrub(e.clientX);
	};
	const onPointerUp = (e: React.PointerEvent) => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* pointer may already be released by the browser */
		}
		// Stay paused — scrub explicitly halts playback per the keybinds
		// spec. The user resumes with Space or the play button.
	};

	return (
		<div className="absolute bottom-3 left-1/2 -translate-x-1/2 w-[min(960px,calc(100%-2rem))] flex items-center gap-3 bg-base-100/90 backdrop-blur border border-base-300 rounded-full pl-1.5 pr-3 py-1 shadow-lg">
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost shrink-0"
				onClick={() => setPlaying(!playing)}
				title={playing ? "Pause" : "Play"}
			>
				{playing ? <HiPause className="size-3.5" /> : <HiPlay className="size-3.5" />}
			</button>
			{clips.length > 1 ? (
				<select
					className="select select-xs select-ghost w-32 shrink-0"
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
				<span
					className="text-[11px] text-base-content/70 truncate max-w-28 shrink-0"
					title={clips[0]?.name || "Clip 1"}
				>
					{clips[0]?.name || "Clip 1"}
				</span>
			)}
			<div
				ref={trackRef}
				role="slider"
				aria-label="Animation timeline"
				aria-valuemin={0}
				aria-valuemax={1}
				tabIndex={0}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				className="relative flex-1 h-6 flex items-center cursor-pointer select-none"
			>
				<div className="relative w-full h-1 rounded-full bg-base-300/80 overflow-hidden">
					<div
						ref={fillRef}
						className="absolute inset-y-0 left-0 bg-primary"
						style={{ width: "0%" }}
					/>
				</div>
				<div
					ref={handleRef}
					className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-3 rounded-full bg-primary shadow"
					style={{ left: "0%" }}
				/>
			</div>
			<div className="flex flex-col items-end text-[10px] tabular-nums text-base-content/60 shrink-0 leading-tight w-28">
				<span ref={timeLabelRef}>0:00.00 / 0:00.00</span>
				<span ref={frameLabelRef} className="text-base-content/45">
					f0 / f0
				</span>
			</div>
		</div>
	);
}

function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
	return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
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
	private skeletonHelper: THREE.SkeletonHelper | null = null;
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

	/// Current playback time and total clip duration in seconds, or null
	/// when no clip is loaded. Read at most once per frame from the React
	/// rAF loop — never stored in React state directly, to avoid forcing
	/// a re-render every frame.
	getProgress(): { time: number; duration: number } | null {
		if (!this.action) return null;
		return {
			time: this.action.time,
			duration: this.action.getClip().duration,
		};
	}

	/// Jump the active action to `fraction * duration` and tick the mixer
	/// with delta 0 so the bones reflect the new pose immediately. Used by
	/// the scrub interaction in the timeline UI.
	seekToFraction(fraction: number): void {
		if (!this.action || !this.mixer) return;
		const duration = this.action.getClip().duration;
		if (duration <= 0) return;
		const clamped = Math.max(0, Math.min(1, fraction));
		this.action.time = clamped * duration;
		this.mixer.update(0);
	}

	/// Advance the action by `delta` frames at the assumed reference FPS,
	/// pausing playback as a side effect. Used by the `,` / `.` hotkeys.
	stepFrames(delta: number, fps: number): void {
		if (!this.action || !this.mixer) return;
		const duration = this.action.getClip().duration;
		if (duration <= 0) return;
		this.action.paused = true;
		const dt = delta / fps;
		this.action.time = Math.max(0, Math.min(duration, this.action.time + dt));
		this.mixer.update(0);
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
		if (this.skeletonHelper) {
			this.scene.remove(this.skeletonHelper);
			this.skeletonHelper.dispose();
			this.skeletonHelper = null;
		}
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

		// FBX/glTF with skeletons need their bone matrices computed up front,
		// or the first frame skins to undefined bone positions and the
		// SkinnedMesh either renders invisibly or lands far off-camera. Also
		// uses bone positions to frame the camera, since Box3.setFromObject
		// on a SkinnedMesh uses bind-pose vertex positions × matrixWorld
		// which can diverge from where the mesh actually renders.
		this.root.updateMatrixWorld(true);
		this.root.traverse((c) => {
			if (c instanceof THREE.SkinnedMesh) {
				c.skeleton.pose();
				c.skeleton.update();
			}
		});

		// Motion-only FBX files (Mixamo retargeting clips, etc.) have a
		// skeleton + animation curves but no character mesh. Detect that and
		// add a SkeletonHelper so the user sees the rig pose animating.
		let hasRenderable = false;
		let hasBones = false;
		this.root.traverse((c) => {
			if (
				c instanceof THREE.Mesh ||
				c instanceof THREE.Points ||
				c instanceof THREE.LineSegments
			) {
				if (c.visible !== false) hasRenderable = true;
			}
			if (c instanceof THREE.Bone) hasBones = true;
		});
		if (!hasRenderable && hasBones) {
			this.skeletonHelper = new THREE.SkeletonHelper(this.root);
			this.scene.add(this.skeletonHelper);
		}

		this.clips = result.animations;
		if (this.clips.length > 0) {
			this.mixer = new THREE.AnimationMixer(this.root);
			this.action = this.mixer.clipAction(this.clips[0]);
			this.action.play();
			// Tick once so the initial frame already reflects time 0 of the
			// clip — keeps the camera frame computed below honest.
			this.mixer.update(0);
		}

		this.frameObject(this.root);
	}

	private frameObject(object: THREE.Object3D): void {
		const box = new THREE.Box3().setFromObject(object);
		object.traverse((c) => {
			if (c instanceof THREE.Bone) {
				box.expandByPoint(
					new THREE.Vector3().setFromMatrixPosition(c.matrixWorld),
				);
			}
		});
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

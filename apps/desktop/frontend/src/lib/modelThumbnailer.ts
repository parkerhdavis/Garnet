// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offscreen Three.js renderer that produces thumbnail PNGs for 3D model
//! assets. Counterpart to the Rust image/video thumbnail pipeline — we run
//! in the frontend because rendering needs WebGL.
//!
//! Architecture:
//!   - A single shared WebGLRenderer + scene + camera is kept alive while
//!     there's a queue; idle-teared-down after N seconds of inactivity to
//!     release the GPU context.
//!   - One job processed at a time. Each new job is scheduled via
//!     `requestIdleCallback` (fallback `setTimeout`) so renders only happen
//!     when the JS main thread is otherwise free — if the user is
//!     scrolling/clicking, generation pauses.
//!   - Each job: load via the right addon loader → frame camera to the
//!     model's bounding box → render → `toDataURL` → `save_model_thumbnail`.
//!     The Rust command writes the PNG to the same on-disk cache that
//!     `get_thumbnail` looks up, and emits `thumbnail:ready` so the existing
//!     `thumbnailBus` wiring dispatches the new path to the right tile.
//!
//! Webkit2gtk gotchas learned the hard way:
//!   - WebGL's main framebuffer behaves badly when the canvas isn't visible
//!     in the layout — geometry doesn't actually rasterize, only the clear
//!     color survives, even with `preserveDrawingBuffer: true`. So we don't
//!     render to the canvas at all: every job renders into an off-screen
//!     `WebGLRenderTarget`, reads back the pixels, and stamps them onto a
//!     2D canvas which we then `toDataURL`. The 2D-canvas readback is
//!     immune to whatever WebKit is doing with off-viewport WebGL contexts.
//!   - `alpha: true` + `null` background also produces transparent
//!     framebuffers on this platform — irrelevant now that we render to an
//!     FBO, but worth noting for any future change that switches back.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/tauri";

const IDLE_TEARDOWN_MS = 30_000;
const IDLE_SCHEDULE_TIMEOUT_MS = 500;

const MODEL_KINDS = ["gltf", "glb", "obj", "stl", "ply", "fbx"] as const;
type ModelKind = (typeof MODEL_KINDS)[number];

type Job = {
	key: string;
	absPath: string;
	mtime: number | null;
	size: number;
	kind: ModelKind;
	resolve: (ok: boolean) => void;
};

function detectKind(format: string | null): ModelKind | null {
	if (!format) return null;
	const e = format.toLowerCase();
	return (MODEL_KINDS as readonly string[]).includes(e) ? (e as ModelKind) : null;
}

function jobKey(absPath: string, mtime: number | null, size: number): string {
	return `${absPath}|${mtime ?? "null"}|${size}`;
}

/// Run `fn` when the JS main thread is idle. Real `requestIdleCallback`
/// isn't universally available in webkit2gtk; the setTimeout fallback gives
/// us deferred-but-not-instant execution which is good enough — by the time
/// the next tick runs, any in-flight user interactions have queued ahead.
function scheduleIdle(fn: () => void): void {
	const w = window as unknown as {
		requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => void;
	};
	if (typeof w.requestIdleCallback === "function") {
		w.requestIdleCallback(fn, { timeout: IDLE_SCHEDULE_TIMEOUT_MS });
	} else {
		setTimeout(fn, 50);
	}
}

class Thumbnailer {
	private queue: Job[] = [];
	private inFlight = new Map<string, Promise<boolean>>();
	private running = false;
	private renderer: THREE.WebGLRenderer | null = null;
	private scene: THREE.Scene | null = null;
	private camera: THREE.PerspectiveCamera | null = null;
	private envRT: THREE.WebGLRenderTarget | null = null;
	private fbo: THREE.WebGLRenderTarget | null = null;
	private readbackCanvas: HTMLCanvasElement | null = null;
	private readbackCtx: CanvasRenderingContext2D | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private currentSize = 0;
	private loaders: {
		gltf: GLTFLoader;
		obj: OBJLoader;
		stl: STLLoader;
		ply: PLYLoader;
		fbx: FBXLoader;
	} | null = null;

	/// Queue a thumbnail render. Returns a promise that resolves true if the
	/// generated PNG was saved, false on any failure. The promise resolution
	/// is a "this work is done" signal — the actual UI update happens
	/// independently via the `thumbnail:ready` event the Rust save command
	/// emits.
	///
	/// Duplicate calls for the same `(absPath, mtime, size)` while a request
	/// is in flight return the same promise. `force: true` bypasses the
	/// dedup (used for refresh actions).
	request(
		absPath: string,
		mtime: number | null,
		size: number,
		format: string | null,
		opts?: { force?: boolean },
	): Promise<boolean> {
		const kind = detectKind(format);
		if (!kind) return Promise.resolve(false);
		const key = jobKey(absPath, mtime, size);
		if (!opts?.force) {
			const existing = this.inFlight.get(key);
			if (existing) return existing;
		}
		const promise = new Promise<boolean>((resolve) => {
			this.queue.push({ key, absPath, mtime, size, kind, resolve });
		});
		this.inFlight.set(key, promise);
		this.scheduleNext();
		return promise;
	}

	private scheduleNext(): void {
		if (this.running) return;
		if (this.queue.length === 0) return;
		this.running = true;
		this.cancelIdleTimer();
		scheduleIdle(() => this.drainOnce());
	}

	private async drainOnce(): Promise<void> {
		const job = this.queue.shift();
		if (!job) {
			this.running = false;
			this.scheduleIdleTeardown();
			return;
		}
		let ok = false;
		try {
			ok = await this.processJob(job);
		} catch (e) {
			console.warn("[modelThumbnailer] job error", job.absPath, e);
		} finally {
			this.inFlight.delete(job.key);
			job.resolve(ok);
		}
		this.running = false;
		if (this.queue.length > 0) {
			this.scheduleNext();
		} else {
			this.scheduleIdleTeardown();
		}
	}

	private async processJob(job: Job): Promise<boolean> {
		this.ensureRenderer(job.size);
		const url = convertFileSrc(job.absPath);
		const object = await this.loadModel(url, job.kind);
		if (!object) return false;

		const scene = this.scene!;
		const camera = this.camera!;
		const renderer = this.renderer!;

		scene.add(object);
		try {
			frameObjectInCamera(object, camera);
			const dataUrl = this.renderToDataUrl(scene, camera, job.size);
			if (!dataUrl) return false;
			const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
			try {
				await api.saveModelThumbnail(job.absPath, job.mtime, job.size, b64);
				return true;
			} catch (e) {
				console.warn("[modelThumbnailer] saveModelThumbnail failed", e);
				return false;
			}
		} finally {
			scene.remove(object);
			disposeObject(object);
		}
	}

	/// Render the scene into an off-screen FBO, read the pixels back, paint
	/// them into a 2D canvas, and return a `data:image/png;base64,…` URL.
	/// 2D canvas `toDataURL` is unaffected by WebKit2GTK's quirks around
	/// off-viewport WebGL canvases, so this works regardless of where (or
	/// whether) our renderer's canvas lives in the DOM.
	private renderToDataUrl(
		scene: THREE.Scene,
		camera: THREE.PerspectiveCamera,
		size: number,
	): string | null {
		const renderer = this.renderer;
		const fbo = this.fbo;
		const canvas = this.readbackCanvas;
		const ctx = this.readbackCtx;
		if (!renderer || !fbo || !canvas || !ctx) return null;

		renderer.setRenderTarget(fbo);
		renderer.clear();
		renderer.render(scene, camera);
		const pixels = new Uint8Array(size * size * 4);
		renderer.readRenderTargetPixels(fbo, 0, 0, size, size, pixels);
		renderer.setRenderTarget(null);

		// WebGL's framebuffer origin is bottom-left; canvas ImageData is
		// top-left. Flip rows on the way in so the saved PNG is right-side-up.
		const imageData = ctx.createImageData(size, size);
		const rowBytes = size * 4;
		for (let y = 0; y < size; y++) {
			const src = (size - 1 - y) * rowBytes;
			const dst = y * rowBytes;
			imageData.data.set(pixels.subarray(src, src + rowBytes), dst);
		}
		ctx.putImageData(imageData, 0, 0);
		return canvas.toDataURL("image/png");
	}

	private ensureRenderer(size: number): void {
		if (this.renderer && this.currentSize === size) return;
		if (this.renderer) this.disposeRenderer();
		this.currentSize = size;

		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setPixelRatio(1);
		renderer.setSize(size, size, false);
		renderer.setClearColor(0x1a1a1a, 1);
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.0;
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer = renderer;

		// Off-screen FBO we actually render into. Reading pixels back from
		// this and stamping them onto a 2D canvas avoids webkit2gtk's
		// off-viewport WebGL-canvas weirdness entirely.
		this.fbo = new THREE.WebGLRenderTarget(size, size, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.UnsignedByteType,
			colorSpace: THREE.SRGBColorSpace,
		});

		const readback = document.createElement("canvas");
		readback.width = size;
		readback.height = size;
		this.readbackCanvas = readback;
		this.readbackCtx = readback.getContext("2d");

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x1a1a1a);
		const pmrem = new THREE.PMREMGenerator(renderer);
		this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
		scene.environment = this.envRT.texture;
		pmrem.dispose();

		const dir = new THREE.DirectionalLight(0xffffff, 1.2);
		dir.position.set(2, 3, 2);
		scene.add(dir);
		scene.add(new THREE.AmbientLight(0xffffff, 0.15));
		this.scene = scene;

		this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

		this.loaders = {
			gltf: new GLTFLoader(),
			obj: new OBJLoader(),
			stl: new STLLoader(),
			ply: new PLYLoader(),
			fbx: new FBXLoader(),
		};
	}

	private async loadModel(url: string, kind: ModelKind): Promise<THREE.Object3D | null> {
		const loaders = this.loaders!;
		try {
			switch (kind) {
				case "gltf":
				case "glb": {
					const gltf = await loaders.gltf.loadAsync(url);
					return gltf.scene;
				}
				case "obj":
					return await loaders.obj.loadAsync(url);
				case "fbx":
					return await loaders.fbx.loadAsync(url);
				case "stl": {
					const geom = await loaders.stl.loadAsync(url);
					geom.computeVertexNormals();
					const mat = new THREE.MeshStandardMaterial({
						color: 0xb0b0b0,
						metalness: 0.1,
						roughness: 0.6,
					});
					return new THREE.Mesh(geom, mat);
				}
				case "ply": {
					const geom = await loaders.ply.loadAsync(url);
					geom.computeVertexNormals();
					const hasColor = !!geom.getAttribute("color");
					const mat = new THREE.MeshStandardMaterial({
						color: hasColor ? 0xffffff : 0xb0b0b0,
						vertexColors: hasColor,
						metalness: 0.1,
						roughness: 0.6,
					});
					return new THREE.Mesh(geom, mat);
				}
			}
		} catch (e) {
			console.warn("[modelThumbnailer] load failed", url, e);
			return null;
		}
	}

	private cancelIdleTimer(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private scheduleIdleTeardown(): void {
		this.cancelIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (!this.running && this.queue.length === 0) this.disposeRenderer();
		}, IDLE_TEARDOWN_MS);
	}

	private disposeRenderer(): void {
		if (this.envRT) {
			this.envRT.dispose();
			this.envRT = null;
		}
		if (this.fbo) {
			this.fbo.dispose();
			this.fbo = null;
		}
		if (this.scene) {
			this.scene.environment = null;
			this.scene = null;
		}
		this.renderer?.dispose();
		this.renderer = null;
		this.camera = null;
		this.loaders = null;
		this.readbackCanvas = null;
		this.readbackCtx = null;
		this.currentSize = 0;
	}
}

function frameObjectInCamera(object: THREE.Object3D, camera: THREE.PerspectiveCamera): void {
	const box = new THREE.Box3().setFromObject(object);
	if (!Number.isFinite(box.min.x) || box.isEmpty()) {
		camera.position.set(0, 0.5, 2);
		camera.lookAt(0, 0, 0);
		camera.updateProjectionMatrix();
		return;
	}
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	const maxDim = Math.max(size.x, size.y, size.z);
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

export const modelThumbnailer = new Thumbnailer();

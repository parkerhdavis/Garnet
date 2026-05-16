// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, type ScanReport } from "@/lib/tauri";
import { emitThumbnailReady, type ThumbnailReady } from "@/lib/thumbnailBus";
import { useBgTasksStore } from "@/stores/bgTasksStore";
import { useBootStore } from "@/stores/bootStore";
import { ConfirmDialogRoot } from "@/components/ConfirmDialog";
import { ContextMenuRoot } from "@/components/ContextMenu";
import { Layout } from "@/components/Layout";
import { PromptDialogRoot } from "@/components/PromptDialog";
import { useSelectionStore } from "@/stores/selectionStore";
import { useUndoStore } from "@/stores/undoStore";
import { AppKeybindsPage } from "@/pages/AppKeybindsPage";
import { AppStatsPage } from "@/pages/AppStatsPage";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import {
	AppAboutPage,
	AutomationsPage,
	PluginsPage,
	SettingsAppearancePage,
	SettingsGeneralPage,
	WorkspacesPage,
} from "@/pages/stubs";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { usePrefsStore } from "@/stores/prefsStore";

// Min dwell before fade-out begins. The fade itself runs for SPLASH_FADE_MS
// (must match the `duration-[Nms]` utility on the splash overlay below).
const SPLASH_MIN_MS = 1800;
const SPLASH_FADE_MS = 500;

export default function App() {
	const { loaded, splashGone } = useSplashTimer();
	useScanEventBridge();
	useThumbnailReadyBridge();
	useGlobalHotkeys();
	usePrefsRefreshBridge();

	return (
		<ErrorBoundary>
			<HashRouter>
				<Routes>
					<Route element={<Layout />}>
						<Route index element={<LibraryPage />} />
						<Route path="asset/:id" element={<AssetDetailPage />} />

						<Route path="workspaces" element={<WorkspacesPage />} />

						<Route path="types/:kind" element={<LibraryPage />} />

						{/* `/` and `/sources/:id` mount the same LibraryPage; the
						    page reads useParams to decide whether to apply the
						    pinned-source filter. This keeps StrictMode from
						    introducing spurious "clear filter" refreshes on the
						    component swap. */}
						<Route path="sources/:id" element={<LibraryPage />} />

						<Route path="functions/plugins" element={<PluginsPage />} />
						<Route path="functions/automations" element={<AutomationsPage />} />

						<Route path="settings" element={<SettingsPage />} />
						<Route path="settings/library" element={<SettingsPage />} />
						<Route path="settings/appearance" element={<SettingsAppearancePage />} />
						<Route path="settings/general" element={<SettingsGeneralPage />} />
						{/* About moved to /app/about as part of the App sidebar
						    section. Keep the old URL working in case anything
						    deep-links to it. */}
						<Route path="settings/about" element={<Navigate to="/app/about" replace />} />

						<Route path="app/stats" element={<AppStatsPage />} />
						<Route path="app/keybinds" element={<AppKeybindsPage />} />
						<Route path="app/about" element={<AppAboutPage />} />

						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			</HashRouter>

			<ContextMenuRoot />
			<ConfirmDialogRoot />
			<PromptDialogRoot />

			{!splashGone && <Splash fadeOut={loaded} />}
		</ErrorBoundary>
	);
}

/// Pre-warms the initial library + assets queries. Once both report
/// loading=false AND `SPLASH_MIN_MS` has elapsed, `loaded` flips (starts the
/// fade); SPLASH_FADE_MS later `splashGone` flips (unmounts the splash).
///
/// The router is always rendered from the first frame — the splash overlays
/// it with `fixed inset-0` and a high z-index, so when the splash fades its
/// opacity transition reveals the (already-rendered, already-laid-out)
/// library underneath. The min-h-0 fix on LibraryPage means the layout chain
/// no longer depends on what wraps the router, so this works cleanly.
function useSplashTimer() {
	const refreshLibrary = useLibraryStore((s) => s.refresh);
	const refreshAssets = useAssetsStore((s) => s.refresh);
	const libraryLoading = useLibraryStore((s) => s.loading);
	const assetsLoading = useAssetsStore((s) => s.loading);
	const [mountedAt] = useState(() => performance.now());
	const [loaded, setLoaded] = useState(false);
	const [splashGone, setSplashGone] = useState(false);

	// One-shot guards — React StrictMode runs effects twice in dev (mount,
	// cleanup, remount) which would otherwise duplicate every checkpoint in
	// the report. Refs survive the strict-mode double-invoke.
	const marks = useRef({
		reactMounted: false,
		dataLoaded: false,
		splashMin: false,
		splashGone: false,
		finalized: false,
	});
	const markOnce = (key: keyof typeof marks.current, label: string) => {
		if (marks.current[key]) return;
		marks.current[key] = true;
		void api.markStartupPhase(label).catch(() => {});
	};

	// Earliest moment React has run its first effect — close enough to "first
	// paint" for our purposes (the splash overlay is the first thing painted).
	useEffect(() => {
		markOnce("reactMounted", "frontend: React mounted");
	}, []);

	useEffect(() => {
		void Promise.all([refreshLibrary(), refreshAssets()]).then(() => {
			markOnce("dataLoaded", "frontend: initial data loaded");
		});
	}, [refreshLibrary, refreshAssets]);

	useEffect(() => {
		if (loaded) return;
		if (libraryLoading || assetsLoading) return;
		const elapsed = performance.now() - mountedAt;
		const waitMore = Math.max(0, SPLASH_MIN_MS - elapsed);
		const t = setTimeout(() => {
			markOnce("splashMin", "frontend: splash min elapsed (fade starts)");
			setLoaded(true);
		}, waitMore);
		return () => clearTimeout(t);
	}, [libraryLoading, assetsLoading, mountedAt, loaded]);

	useEffect(() => {
		if (!loaded || splashGone) return;
		const t = setTimeout(() => {
			markOnce("splashGone", "frontend: splash fade complete");
			setSplashGone(true);
		}, SPLASH_FADE_MS);
		return () => clearTimeout(t);
	}, [loaded, splashGone]);

	// Once the splash is gone, freeze the timing report and flip the boot
	// gate so anything subscribed via `awaitBootReady` starts running. The
	// gate is what keeps background tasks (e.g. thumbnail generation) from
	// competing with startup work during the splash window.
	useEffect(() => {
		if (!splashGone) return;
		if (marks.current.finalized) return;
		marks.current.finalized = true;
		void api.finalizeStartupTimings(SPLASH_MIN_MS + SPLASH_FADE_MS).catch(() => {});
		useBootStore.getState().markReady();
	}, [splashGone]);

	return { loaded, splashGone };
}

/// Bridges the Rust-side scan lifecycle events into the zustand stores:
///   - `scan:started`   → libraryStore marks the root as in-progress
///   - `scan:completed` → libraryStore stores the report + clears in-progress,
///                        assetsStore refreshes to pick up the new rows
///   - `scan:failed`    → libraryStore clears in-progress, records the error
///
/// One subscriber at the App level so the listeners survive page navigation.
function useScanEventBridge() {
	useEffect(() => {
		const unlistens: Array<() => void> = [];
		const setError = (msg: string) => useLibraryStore.setState({ error: msg });

		const scanTaskId = (rootId: number) => `scan:${rootId}`;

		void listen<number>("scan:started", (e) => {
			useLibraryStore.getState()._markScanStarted(e.payload);
			useBgTasksStore
				.getState()
				.add({ id: scanTaskId(e.payload), kind: "scan", label: "Scanning library" });
		}).then((u) => unlistens.push(u));

		void listen<ScanReport>("scan:completed", (e) => {
			const report = e.payload;
			useLibraryStore.getState()._markScanFinished(report.root_id, report);
			useBgTasksStore.getState().remove(scanTaskId(report.root_id));
			// New rows may have landed — refresh the visible library view.
			void useAssetsStore.getState().refresh();
		}).then((u) => unlistens.push(u));

		void listen<{ root_id: number; error: string }>("scan:failed", (e) => {
			useLibraryStore.getState()._markScanFinished(e.payload.root_id, null);
			useBgTasksStore.getState().remove(scanTaskId(e.payload.root_id));
			setError(`Scan failed: ${e.payload.error}`);
		}).then((u) => unlistens.push(u));

		return () => {
			for (const u of unlistens) u();
		};
	}, []);
}

/// Single app-wide subscription to `thumbnail:ready`. Fans the payload out
/// through `thumbnailBus` so each AssetThumbnail receives only its own key
/// — 60 listening tiles would otherwise mean 60 separate Tauri listeners
/// all rejecting 59/60 events apiece.
function useThumbnailReadyBridge() {
	useEffect(() => {
		let unlisten: (() => void) | null = null;
		void listen<ThumbnailReady>("thumbnail:ready", (e) => {
			emitThumbnailReady(e.payload);
		}).then((u) => {
			unlisten = u;
		});
		return () => {
			unlisten?.();
		};
	}, []);
}

/// App-wide keyboard shortcuts. Lives at the App level so any focused
/// page sees them — skips when an editable element currently owns focus
/// so typing into a text field doesn't unexpectedly trigger.
///
/// Reads the current route via `window.location.hash` (HashRouter's source
/// of truth) and navigates via `window.history.back/forward` directly,
/// which sidesteps the need to live inside the HashRouter context.
function useGlobalHotkeys() {
	useEffect(() => {
		function isEditable(target: EventTarget | null): boolean {
			const el = target as HTMLElement | null;
			if (!el) return false;
			const tag = el.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
			if (el.isContentEditable) return true;
			return false;
		}

		function onAssetDetailPage(): boolean {
			// HashRouter stores the route in the URL fragment as `#/asset/123`.
			return window.location.hash.startsWith("#/asset/");
		}

		function onKey(e: KeyboardEvent) {
			if (isEditable(e.target)) return;

			// ---- Navigation: Alt+Left/Right + macOS Cmd+[/Cmd+]. ----
			if (e.altKey && !e.ctrlKey && !e.metaKey) {
				if (e.key === "ArrowLeft") {
					e.preventDefault();
					window.history.back();
					return;
				}
				if (e.key === "ArrowRight") {
					e.preventDefault();
					window.history.forward();
					return;
				}
			}
			if (e.metaKey && !e.ctrlKey && !e.altKey) {
				if (e.key === "[") {
					e.preventDefault();
					window.history.back();
					return;
				}
				if (e.key === "]") {
					e.preventDefault();
					window.history.forward();
					return;
				}
			}

			// ---- Escape: context-aware. On a detail page it closes back
			// to the library; otherwise it clears selection.
			if (e.key === "Escape") {
				if (onAssetDetailPage()) {
					window.history.back();
				} else {
					useSelectionStore.getState().clear();
				}
				return;
			}

			const mod = e.ctrlKey || e.metaKey;
			if (!mod) return;
			// Lowercase `e.key` for the comparison — when Shift is held,
			// browsers report the shifted character (`Z`, not `z`), so a
			// case-sensitive compare would miss Ctrl+Shift+Z.
			const key = e.key.toLowerCase();

			// ---- Ctrl/Cmd+D deselects all (in addition to Esc above). ----
			if (key === "d" && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				useSelectionStore.getState().clear();
				return;
			}

			// ---- Undo / redo. ----
			if (key === "z" && !e.shiftKey) {
				e.preventDefault();
				void useUndoStore.getState().undo();
			} else if ((key === "z" && e.shiftKey) || key === "y") {
				e.preventDefault();
				void useUndoStore.getState().redo();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}

/// Re-runs the assets query whenever the user toggles a preference that
/// changes filter semantics. Currently just the GIF-bucket toggle (which
/// shifts whether GIF/APNG/animated WebP belong to Images or Animations).
/// Skips the initial mount — the first refresh is driven by useSplashTimer.
function usePrefsRefreshBridge() {
	const bucket = usePrefsStore((s) => s.animatedImagesBucket);
	const [first, setFirst] = useState(true);
	useEffect(() => {
		if (first) {
			setFirst(false);
			return;
		}
		void useAssetsStore.getState().refresh();
	}, [bucket, first]);
}

function Splash({ fadeOut }: { fadeOut: boolean }) {
	return (
		<div
			className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-base-200 pointer-events-none transition-opacity duration-[500ms] ease-out ${
				fadeOut ? "opacity-0" : "opacity-100"
			}`}
		>
			<img
				src="/garnet-splash-dark.png"
				alt="Garnet"
				className="size-36 animate-splash-icon"
			/>
			<span className="text-4xl font-bold tracking-tight animate-fade-in-up">
				Garnet
			</span>
		</div>
	);
}

type ErrorBoundaryState = { error: Error | null };

// Top-level error boundary so render-time failures show as a visible message
// (and a console trace) instead of leaving the pre-mount "Loading Garnet…"
// placeholder hanging indefinitely.
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: { componentStack?: string | null }) {
		console.error("Garnet render error:", error, info.componentStack);
	}

	render() {
		if (this.state.error) {
			return (
				<div className="min-h-screen flex items-center justify-center bg-base-200 p-8">
					<div className="card bg-base-100 border border-error/40 max-w-2xl w-full">
						<div className="card-body">
							<h2 className="card-title text-error">Garnet failed to render</h2>
							<pre className="text-xs whitespace-pre-wrap font-mono bg-base-200 p-3 rounded">
								{this.state.error.stack ?? this.state.error.message}
							</pre>
							<p className="text-sm text-base-content/60 mt-2">
								Check the webview devtools console for the full stack.
							</p>
						</div>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}

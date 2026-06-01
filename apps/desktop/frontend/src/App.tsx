// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
	HashRouter,
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { api, type ScanReport } from "@/lib/tauri";
import { pickFileToPreview } from "@/lib/ephemeral";
import { emitThumbnailReady, type ThumbnailReady } from "@/lib/thumbnailBus";
import { useBgTasksStore } from "@/stores/bgTasksStore";
import { useBootStore } from "@/stores/bootStore";
import { BatchRenameDialogRoot } from "@/components/BatchRenameDialog";
import { ConfirmDialogRoot } from "@/components/ConfirmDialog";
import { ContextMenuRoot } from "@/components/ContextMenu";
import { Layout } from "@/components/Layout";
import { PromptDialogRoot } from "@/components/PromptDialog";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useUndoStore } from "@/stores/undoStore";
import { AppKeybindsPage } from "@/pages/AppKeybindsPage";
import { AppStatsPage } from "@/pages/AppStatsPage";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { DuplicatesPage } from "@/pages/DuplicatesPage";
import { EditorPage } from "@/pages/EditorPage";
import { AutomationsPage } from "@/pages/AutomationsPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { PluginsPage } from "@/pages/PluginsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WorkspaceRoute } from "@/pages/WorkspaceRoute";
import {
	AppAboutPage,
	SettingsGeneralPage,
	WorkspacesPage,
} from "@/pages/stubs";
import { SettingsAppearancePage } from "@/pages/SettingsAppearancePage";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { usePrefsStore } from "@/stores/prefsStore";
import { accentHue } from "@/lib/accent";

// Min dwell before fade-out begins. The fade itself runs for SPLASH_FADE_MS
// (must match the `duration-[Nms]` utility on the splash overlay below).
const SPLASH_MIN_MS = 1800;
const SPLASH_FADE_MS = 500;

export default function App() {
	const { loaded, splashGone } = useSplashTimer();
	useScanEventBridge();
	useThumbnailReadyBridge();
	useGlobalHotkeys();
	useApplyZoom();
	useApplyAccent();
	usePrefsRefreshBridge();

	return (
		<ErrorBoundary>
			<HashRouter>
				<RouteMemory />
				<Routes>
					<Route element={<Layout />}>
						<Route index element={<LibraryPage />} />
						<Route path="asset/:id" element={<AssetDetailPage />} />
						<Route path="edit/:id" element={<EditorPage />} />

						{/* Ad-hoc ("ephemeral") open: a single file outside any
						    library root, addressed by `?path=` instead of an
						    integer id. The same pages mount in ephemeral mode and
						    branch on `isEphemeral(asset)` for id-only features. */}
						<Route path="preview" element={<AssetDetailPage />} />
						<Route path="edit" element={<EditorPage />} />

						<Route path="workspaces" element={<WorkspacesPage />} />
						<Route path="workspaces/:id" element={<WorkspaceRoute />} />

						<Route path="types/:kind" element={<LibraryPage />} />

						<Route path="duplicates" element={<DuplicatesPage />} />

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
						<Route
							path="settings/appearance"
							element={<SettingsAppearancePage />}
						/>
						<Route path="settings/general" element={<SettingsGeneralPage />} />
						{/* About moved to /app/about as part of the App sidebar
						    section. Keep the old URL working in case anything
						    deep-links to it. */}
						<Route
							path="settings/about"
							element={<Navigate to="/app/about" replace />}
						/>

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
			<BatchRenameDialogRoot />

			{!splashGone && <Splash fadeOut={loaded} />}
		</ErrorBoundary>
	);
}

/// Pre-warms the initial library + assets queries and drives the splash. The
/// window starts hidden and is revealed once React commits (see the reveal
/// effect); `SPLASH_MIN_MS` is then counted from that reveal, so the splash is
/// shown on-screen for its full duration. Once both queries report
/// loading=false AND that dwell has elapsed, `loaded` flips (starts the fade);
/// SPLASH_FADE_MS later `splashGone` flips (unmounts the splash).
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
	// Set to the timestamp at which we reveal the (initially hidden) window.
	// The splash min-dwell is measured from here, not from React mount, so the
	// splash is always shown on-screen for its full duration regardless of how
	// long the window stayed hidden while the webview warmed up.
	const [revealedAt, setRevealedAt] = useState<number | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [splashGone, setSplashGone] = useState(false);

	// One-shot guards — React StrictMode runs effects twice in dev (mount,
	// cleanup, remount) which would otherwise duplicate every checkpoint in
	// the report. Refs survive the strict-mode double-invoke.
	const marks = useRef({
		reactMounted: false,
		windowRevealed: false,
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

	// Reveal the window once React has committed the splash. The window is
	// created hidden (tauri.conf.json `visible: false`) so the OS never shows
	// the unpainted webview, the static `index.html` loading fallback, or the
	// live `set_size` resize in Rust `.setup()`. Its first on-screen frame is
	// the splash.
	//
	// We schedule the reveal with setTimeout, NOT requestAnimationFrame:
	// webkit2gtk does not service rAF while the window is hidden (nothing is
	// being composited), so an rAF-gated reveal never fires — the splash would
	// then animate and time out entirely off-screen and the window would pop
	// straight to the library. setTimeout fires regardless of visibility. The
	// window's `backgroundColor` is the splash colour, so the first frame is
	// seamless even before the icon PNG decodes. A Rust-side safety timer is
	// the last-resort backstop if this never runs at all.
	useEffect(() => {
		markOnce("reactMounted", "frontend: React mounted");
		const t = setTimeout(() => {
			setRevealedAt((prev) => prev ?? performance.now());
			markOnce("windowRevealed", "frontend: window revealed");
			void api.showMainWindow().catch(() => {});
		}, 0);
		return () => clearTimeout(t);
	}, []);

	useEffect(() => {
		void Promise.all([refreshLibrary(), refreshAssets()]).then(() => {
			markOnce("dataLoaded", "frontend: initial data loaded");
		});
	}, [refreshLibrary, refreshAssets]);

	useEffect(() => {
		if (loaded) return;
		// Hold the splash until the window is actually visible AND the initial
		// data has landed; only then start counting down the minimum dwell.
		if (revealedAt === null) return;
		if (libraryLoading || assetsLoading) return;
		const elapsed = performance.now() - revealedAt;
		const waitMore = Math.max(0, SPLASH_MIN_MS - elapsed);
		const t = setTimeout(() => {
			markOnce("splashMin", "frontend: splash min elapsed (fade starts)");
			setLoaded(true);
		}, waitMore);
		return () => clearTimeout(t);
	}, [libraryLoading, assetsLoading, revealedAt, loaded]);

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
		void api
			.finalizeStartupTimings(SPLASH_MIN_MS + SPLASH_FADE_MS)
			.catch(() => {});
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
			useBgTasksStore.getState().add({
				id: scanTaskId(e.payload),
				kind: "scan",
				label: "Scanning library",
			});
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

/// Move the active selection up/down the sidebar's nav items (Alt+Up/Down).
/// Reads the rendered links straight from the DOM in document (= visual) order
/// rather than duplicating the sidebar's structure, so dynamic items
/// (workspaces, pinned sources) are included automatically. The active item
/// carries NavLink's `aria-current="page"`; from an off-sidebar route (e.g. an
/// asset detail page) we enter at the first (down) or last (up) item. Clamps at
/// the ends rather than wrapping.
function navigateSidebar(direction: 1 | -1) {
	const links = Array.from(
		document.querySelectorAll<HTMLAnchorElement>('aside nav a[href^="#/"]'),
	);
	if (links.length === 0) return;
	let idx = links.findIndex((a) => a.getAttribute("aria-current") === "page");
	if (idx < 0) {
		const hash = window.location.hash || "#/";
		idx = links.findIndex((a) => a.getAttribute("href") === hash);
	}
	let nextIdx: number;
	if (idx < 0) {
		nextIdx = direction === 1 ? 0 : links.length - 1;
	} else {
		nextIdx = idx + direction;
		if (nextIdx < 0 || nextIdx >= links.length) return; // clamp at ends
	}
	const next = links[nextIdx];
	const href = next.getAttribute("href");
	if (!href) return;
	window.location.hash = href;
	next.scrollIntoView({ block: "nearest" });
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
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")
				return true;
			if (el.isContentEditable) return true;
			return false;
		}

		function onAssetDetailPage(): boolean {
			// HashRouter stores the route in the URL fragment as `#/asset/123`
			// (catalog) or `#/preview?path=…` (ad-hoc). Escape closes both.
			const h = window.location.hash;
			return h.startsWith("#/asset/") || h.startsWith("#/preview");
		}

		function onKey(e: KeyboardEvent) {
			// ---- Command palette: Ctrl/Cmd+K toggles it. Checked before the
			// editable guard so it works even while focus is in a text field. ----
			if (
				(e.ctrlKey || e.metaKey) &&
				!e.altKey &&
				!e.shiftKey &&
				e.key.toLowerCase() === "k"
			) {
				e.preventDefault();
				useCommandPaletteStore.getState().toggle();
				return;
			}
			// While the palette is open it owns the keyboard (its own handler
			// drives arrows/enter/escape) — suppress the app-level shortcuts.
			if (useCommandPaletteStore.getState().open) return;

			if (isEditable(e.target)) return;

			// ---- Navigation: Alt+Left/Right (history) + Alt+Up/Down (sidebar)
			// + macOS Cmd+[/Cmd+]. ----
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
				if (e.key === "ArrowUp") {
					e.preventDefault();
					navigateSidebar(-1);
					return;
				}
				if (e.key === "ArrowDown") {
					e.preventDefault();
					navigateSidebar(1);
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

			// ---- Ctrl/Cmd+O opens a loose file ad-hoc (ephemeral preview). ----
			if (key === "o" && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				// Outside the HashRouter context here, so pickFileToPreview
				// falls back to setting window.location.hash itself.
				void pickFileToPreview();
				return;
			}

			// ---- Ctrl/Cmd+D deselects all (in addition to Esc above). ----
			if (key === "d" && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				useSelectionStore.getState().clear();
				return;
			}

			// ---- Application zoom: Ctrl/Cmd + (in), - (out), 0 (reset). ----
			// "=" / "+" share a physical key; "-" / "_" likewise.
			if (key === "=" || key === "+") {
				e.preventDefault();
				usePrefsStore.getState().zoomIn();
				return;
			}
			if (key === "-" || key === "_") {
				e.preventDefault();
				usePrefsStore.getState().zoomOut();
				return;
			}
			if (key === "0") {
				e.preventDefault();
				usePrefsStore.getState().resetZoom();
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

/// Applies the persisted zoom factor to the webview — on mount (restoring the
/// last-used zoom) and whenever it changes via the Ctrl +/-/0 shortcuts. The
/// webview's own zoom doesn't persist across launches, so we re-apply it here.
function useApplyZoom() {
	const zoom = usePrefsStore((s) => s.zoom);
	useEffect(() => {
		void getCurrentWebview()
			.setZoom(zoom)
			.catch(() => {});
	}, [zoom]);
}

/// Applies the chosen accent preset by writing its hue to `--garnet-hue` on the
/// root element — on mount (restoring the persisted choice) and on every
/// change. The theme's primary/accent colors read that variable, so the whole
/// accent family (and the masked brand logo) recolors live. Also swaps the
/// running window's OS icon to the matching gem.
function useApplyAccent() {
	const accentId = usePrefsStore((s) => s.accentId);
	useEffect(() => {
		document.documentElement.style.setProperty(
			"--garnet-hue",
			String(accentHue(accentId)),
		);
		void api.setAppIcon(accentId).catch(() => {});
	}, [accentId]);
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

/// Remembers the last visited route and restores it on the next launch, so the
/// app reopens where you left off instead of always landing on the library.
/// Lives inside HashRouter so it can use the router hooks. Persisted to
/// localStorage (pure UX state the frontend owns, like prefsStore).
const LAST_ROUTE_KEY = "garnet:last-route";

function RouteMemory() {
	const location = useLocation();
	const navigate = useNavigate();
	const restored = useRef(false);

	// Restore once, on first mount.
	useEffect(() => {
		if (restored.current) return;
		restored.current = true;
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(LAST_ROUTE_KEY);
		} catch {
			// localStorage unavailable — skip restore.
		}
		const current = location.pathname + location.search;
		if (saved && saved !== current && saved !== "/") {
			navigate(saved, { replace: true });
		}
	}, [location.pathname, location.search, navigate]);

	// Persist on every change (after the initial restore has run).
	useEffect(() => {
		if (!restored.current) return;
		try {
			localStorage.setItem(LAST_ROUTE_KEY, location.pathname + location.search);
		} catch {
			// Ignore quota/availability errors — non-essential.
		}
	}, [location.pathname, location.search]);

	return null;
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
class ErrorBoundary extends Component<
	{ children: ReactNode },
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: { componentStack?: string | null }) {
		console.error("Garnet render error:", error, info.componentStack);
		// The window is created hidden and normally revealed once the splash
		// paints. If the app throws during initial render the splash never
		// mounts, so reveal the window here to surface this error message
		// rather than waiting on the Rust safety timer.
		void api.showMainWindow().catch(() => {});
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

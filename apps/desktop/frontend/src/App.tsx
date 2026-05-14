// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ScanReport } from "@/lib/tauri";
import { ConfirmDialogRoot } from "@/components/ConfirmDialog";
import { ContextMenuRoot } from "@/components/ContextMenu";
import { Layout } from "@/components/Layout";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import {
	AutomationsPage,
	ModulesPage,
	SettingsAboutPage,
	SettingsAppearancePage,
	SettingsGeneralPage,
	TypePage,
	WorkspacesPage,
} from "@/pages/stubs";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

// Min dwell before fade-out begins. The fade itself runs for SPLASH_FADE_MS
// (must match the `duration-[Nms]` utility on the splash overlay below).
const SPLASH_MIN_MS = 1800;
const SPLASH_FADE_MS = 500;

export default function App() {
	const { loaded, splashGone } = useSplashTimer();
	useScanEventBridge();

	return (
		<ErrorBoundary>
			<HashRouter>
				<Routes>
					<Route element={<Layout />}>
						<Route index element={<LibraryPage />} />
						<Route path="asset/:id" element={<AssetDetailPage />} />

						<Route path="workspaces" element={<WorkspacesPage />} />

						<Route path="types/:kind" element={<TypePage />} />

						{/* `/` and `/sources/:id` mount the same LibraryPage; the
						    page reads useParams to decide whether to apply the
						    pinned-source filter. This keeps StrictMode from
						    introducing spurious "clear filter" refreshes on the
						    component swap. */}
						<Route path="sources/:id" element={<LibraryPage />} />

						<Route path="functions/modules" element={<ModulesPage />} />
						<Route path="functions/automations" element={<AutomationsPage />} />

						<Route path="settings" element={<SettingsPage />} />
						<Route path="settings/library" element={<SettingsPage />} />
						<Route path="settings/appearance" element={<SettingsAppearancePage />} />
						<Route path="settings/general" element={<SettingsGeneralPage />} />
						<Route path="settings/about" element={<SettingsAboutPage />} />

						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			</HashRouter>

			<ContextMenuRoot />
			<ConfirmDialogRoot />

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

	useEffect(() => {
		void Promise.all([refreshLibrary(), refreshAssets()]);
	}, [refreshLibrary, refreshAssets]);

	useEffect(() => {
		if (loaded) return;
		if (libraryLoading || assetsLoading) return;
		const elapsed = performance.now() - mountedAt;
		const waitMore = Math.max(0, SPLASH_MIN_MS - elapsed);
		const t = setTimeout(() => setLoaded(true), waitMore);
		return () => clearTimeout(t);
	}, [libraryLoading, assetsLoading, mountedAt, loaded]);

	useEffect(() => {
		if (!loaded || splashGone) return;
		const t = setTimeout(() => setSplashGone(true), SPLASH_FADE_MS);
		return () => clearTimeout(t);
	}, [loaded, splashGone]);

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

		void listen<number>("scan:started", (e) => {
			useLibraryStore.getState()._markScanStarted(e.payload);
		}).then((u) => unlistens.push(u));

		void listen<ScanReport>("scan:completed", (e) => {
			const report = e.payload;
			useLibraryStore.getState()._markScanFinished(report.root_id, report);
			// New rows may have landed — refresh the visible library view.
			void useAssetsStore.getState().refresh();
		}).then((u) => unlistens.push(u));

		void listen<{ root_id: number; error: string }>("scan:failed", (e) => {
			useLibraryStore.getState()._markScanFinished(e.payload.root_id, null);
			setError(`Scan failed: ${e.payload.error}`);
		}).then((u) => unlistens.push(u));

		return () => {
			for (const u of unlistens) u();
		};
	}, []);
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

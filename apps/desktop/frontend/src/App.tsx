// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

export default function App() {
	useSplashCloser();
	return (
		<ErrorBoundary>
			<HashRouter>
				<Routes>
					<Route element={<Layout />}>
						<Route index element={<LibraryPage />} />
						<Route path="asset/:id" element={<AssetDetailPage />} />
						<Route path="settings" element={<SettingsPage />} />
						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			</HashRouter>
		</ErrorBoundary>
	);
}

const SPLASH_MIN_MS = 1800;

/// Pre-warms the initial library + assets queries and signals the Rust side
/// once both have returned, after at least SPLASH_MIN_MS of dwell. The splash
/// is a separate Tauri window (defined in tauri.conf.json); the React app
/// loads invisibly in the main window during this period. Rust's
/// `frontend_ready` command closes the splash and shows the main window.
function useSplashCloser() {
	const refreshLibrary = useLibraryStore((s) => s.refresh);
	const refreshAssets = useAssetsStore((s) => s.refresh);
	const libraryLoading = useLibraryStore((s) => s.loading);
	const assetsLoading = useAssetsStore((s) => s.loading);
	const [mountedAt] = useState(() => performance.now());
	const fired = useRef(false);

	useEffect(() => {
		void Promise.all([refreshLibrary(), refreshAssets()]);
	}, [refreshLibrary, refreshAssets]);

	useEffect(() => {
		if (fired.current) return;
		if (libraryLoading || assetsLoading) return;
		const elapsed = performance.now() - mountedAt;
		const waitMore = Math.max(0, SPLASH_MIN_MS - elapsed);
		const t = setTimeout(() => {
			fired.current = true;
			void invoke("frontend_ready").catch((e) =>
				console.error("frontend_ready failed:", e),
			);
		}, waitMore);
		return () => clearTimeout(t);
	}, [libraryLoading, assetsLoading, mountedAt]);
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
		// Make sure the user actually sees this — the main window is hidden
		// until frontend_ready fires, so a render error pre-ready would
		// otherwise leave them staring at the splash until the 15s safety
		// timeout. Force the main window up so the error UI is visible.
		void invoke("frontend_ready").catch(() => {});
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

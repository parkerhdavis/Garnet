// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

const SPLASH_MIN_MS = 1800; // floor — long enough to actually read the wordmark
const SPLASH_FADE_MS = 700; // matches the splash-out keyframe duration

export default function App() {
	return (
		<ErrorBoundary>
			<SplashGate>
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
			</SplashGate>
		</ErrorBoundary>
	);
}

/// Blocks the router from mounting until the library and assets stores have
/// returned their first query. Pre-warms both queries here so the splash
/// covers actual data-loading time, not just animation. Mirrors the splash
/// pattern in ~/Lily and ~/Packi.
function SplashGate({ children }: { children: ReactNode }) {
	const refreshLibrary = useLibraryStore((s) => s.refresh);
	const refreshAssets = useAssetsStore((s) => s.refresh);
	const libraryLoading = useLibraryStore((s) => s.loading);
	const assetsLoading = useAssetsStore((s) => s.loading);

	const [splashDone, setSplashDone] = useState(false);
	const [fadeOut, setFadeOut] = useState(false);
	const [mountedAt] = useState(() => performance.now());

	useEffect(() => {
		void Promise.all([refreshLibrary(), refreshAssets()]);
	}, [refreshLibrary, refreshAssets]);

	useEffect(() => {
		if (libraryLoading || assetsLoading) return;
		const elapsed = performance.now() - mountedAt;
		const waitMore = Math.max(0, SPLASH_MIN_MS - elapsed);
		const fadeTimer = setTimeout(() => setFadeOut(true), waitMore);
		const doneTimer = setTimeout(
			() => setSplashDone(true),
			waitMore + SPLASH_FADE_MS,
		);
		return () => {
			clearTimeout(fadeTimer);
			clearTimeout(doneTimer);
		};
	}, [libraryLoading, assetsLoading, mountedAt]);

	if (splashDone) return <>{children}</>;

	// Crossfade phase: render the app underneath the splash so the user sees
	// the library rise into view as the splash scales up and out. Without
	// this both elements only swap; with it, the transition feels intentional.
	return (
		<div className="relative min-h-screen">
			{fadeOut && <div className="absolute inset-0 animate-app-in">{children}</div>}
			<div
				className={`absolute inset-0 flex flex-col items-center justify-center gap-5 bg-base-200 ${
					fadeOut ? "animate-splash-out pointer-events-none" : ""
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

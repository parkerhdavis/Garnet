// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

// Min dwell before fade-out begins. The fade itself is the difference between
// these two — keep them in sync with the `transition-opacity duration-*`
// utility on the splash wrapper below.
const SPLASH_MIN_MS = 1800;
const SPLASH_FADE_MS = 400;

export default function App() {
	const { loaded, splashGone } = useSplashTimer();

	return (
		<ErrorBoundary>
			{!splashGone ? (
				<Splash fadeOut={loaded} />
			) : (
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
			)}
		</ErrorBoundary>
	);
}

/// Pre-warms the initial library + assets queries on mount, then arms two
/// timers once both queries land *and* SPLASH_MIN_MS has elapsed: the first
/// flips `loaded` (which triggers the opacity transition on the splash), the
/// second flips `splashGone` (which conditionally swaps the splash out for
/// the router). The Packi/Lily pattern: conditional swap, not overlay — when
/// `splashGone` flips, the splash unmounts cleanly and the router mounts
/// fresh, with no wrapper between them that could disturb the layout chain.
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
		const fade = setTimeout(() => setLoaded(true), waitMore);
		const gone = setTimeout(() => setSplashGone(true), waitMore + SPLASH_FADE_MS);
		return () => {
			clearTimeout(fade);
			clearTimeout(gone);
		};
	}, [libraryLoading, assetsLoading, mountedAt, loaded]);

	return { loaded, splashGone };
}

function Splash({ fadeOut }: { fadeOut: boolean }) {
	return (
		<div
			className={`flex flex-col items-center justify-center min-h-screen gap-5 bg-base-200 transition-opacity duration-[400ms] ${
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

// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { AssetDetailPage } from "@/pages/AssetDetailPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

const SPLASH_MIN_MS = 1800; // floor so the wordmark is actually readable

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

/// Splash gate. The library content is always mounted inside the same
/// `motion.div` wrapper from the first frame — its remount across phases was
/// what caused the earlier "library pops in" glitch. The splash itself is
/// rendered above via AnimatePresence so it can run a real exit animation
/// (scale + fade) instead of disappearing in one frame.
///
/// Timing: the queries kick off on mount; once both stores report not-loading
/// AND the elapsed time has cleared SPLASH_MIN_MS, the splash unmounts. Motion
/// handles its exit; AnimatePresence keeps it in the DOM for the animation's
/// duration.
function SplashGate({ children }: { children: ReactNode }) {
	const refreshLibrary = useLibraryStore((s) => s.refresh);
	const refreshAssets = useAssetsStore((s) => s.refresh);
	const libraryLoading = useLibraryStore((s) => s.loading);
	const assetsLoading = useAssetsStore((s) => s.loading);

	const [splashGone, setSplashGone] = useState(false);
	const [mountedAt] = useState(() => performance.now());

	useEffect(() => {
		void Promise.all([refreshLibrary(), refreshAssets()]);
	}, [refreshLibrary, refreshAssets]);

	useEffect(() => {
		if (libraryLoading || assetsLoading) return;
		const elapsed = performance.now() - mountedAt;
		const waitMore = Math.max(0, SPLASH_MIN_MS - elapsed);
		const t = setTimeout(() => setSplashGone(true), waitMore);
		return () => clearTimeout(t);
	}, [libraryLoading, assetsLoading, mountedAt]);

	// Children render in normal layout flow inside a plain wrapper so the
	// `h-full` / flex chain that Layout depends on isn't disturbed by an
	// extra motion.div in the tree. The splash sits in a `fixed inset-0`
	// overlay above everything, so its presence (and exit animation) never
	// affects the underlying layout.
	return (
		<>
			<div
				className={`h-full transition-opacity duration-[600ms] ease-out ${
					splashGone ? "opacity-100 delay-150" : "opacity-0"
				}`}
			>
				{children}
			</div>

			<AnimatePresence>
				{!splashGone && (
					<motion.div
						key="splash"
						initial={{ opacity: 1 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, scale: 1.06 }}
						transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
						className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-base-200 pointer-events-none"
					>
						<motion.img
							src="/garnet-splash-dark.png"
							alt="Garnet"
							className="size-36"
							initial={{ opacity: 0, scale: 0.72 }}
							animate={{ opacity: 1, scale: 1 }}
							transition={{ duration: 0.8, ease: "easeOut" }}
						/>
						<motion.span
							className="text-4xl font-bold tracking-tight"
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.6, delay: 0.55, ease: "easeOut" }}
						>
							Garnet
						</motion.span>
					</motion.div>
				)}
			</AnimatePresence>
		</>
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

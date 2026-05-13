// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HiFolderPlus, HiArrowPath, HiTrash } from "react-icons/hi2";
import { useLibraryStore } from "@/stores/libraryStore";

export default function App() {
	const { roots, lastScan, loading, error, refresh, addRoot, removeRoot, scanRoot } =
		useLibraryStore();

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function pickAndAddRoot() {
		const selected = await open({ directory: true, multiple: false });
		if (typeof selected === "string") {
			await addRoot(selected);
		}
	}

	return (
		<div className="min-h-screen flex flex-col">
			<header className="navbar bg-base-100 border-b border-base-300 px-4">
				<div className="flex-1">
					<span className="text-xl font-semibold tracking-tight">Garnet</span>
					<span className="ml-3 text-xs text-base-content/60">
						v{__APP_VERSION__}
					</span>
				</div>
				<div className="flex-none">
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={pickAndAddRoot}
					>
						<HiFolderPlus className="size-4" />
						Add library root
					</button>
				</div>
			</header>

			<main className="flex-1 p-6 max-w-4xl w-full mx-auto">
				{error && (
					<div className="alert alert-error mb-4">
						<span>{error}</span>
					</div>
				)}

				{loading && roots.length === 0 ? (
					<div className="text-base-content/60">Loading…</div>
				) : roots.length === 0 ? (
					<EmptyState onAdd={pickAndAddRoot} />
				) : (
					<div className="flex flex-col gap-3">
						<h2 className="text-lg font-medium">Library roots</h2>
						{roots.map((root) => (
							<div
								key={root.id}
								className="card bg-base-100 border border-base-300"
							>
								<div className="card-body p-4 flex-row items-center gap-3">
									<div className="flex-1 min-w-0">
										<div className="font-mono text-sm truncate">
											{root.path}
										</div>
										<div className="text-xs text-base-content/60">
											added {new Date(root.added_at * 1000).toLocaleString()}
										</div>
									</div>
									<button
										type="button"
										className="btn btn-sm"
										onClick={() => scanRoot(root.id)}
									>
										<HiArrowPath className="size-4" />
										Scan
									</button>
									<button
										type="button"
										className="btn btn-sm btn-ghost text-error"
										onClick={() => removeRoot(root.id)}
										aria-label="Remove root"
									>
										<HiTrash className="size-4" />
									</button>
								</div>
							</div>
						))}

						{lastScan && (
							<div className="alert mt-2">
								<span>
									Scan complete — {lastScan.files_inserted} indexed,{" "}
									{lastScan.files_skipped} skipped (of{" "}
									{lastScan.files_seen} seen).
								</span>
							</div>
						)}
					</div>
				)}
			</main>

			<footer className="text-center text-xs text-base-content/50 p-3 border-t border-base-300">
				Phase 1 starter — base toolkit, modules disabled.
			</footer>
		</div>
	);
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
	return (
		<div className="card bg-base-100 border border-base-300">
			<div className="card-body items-center text-center py-12">
				<h2 className="card-title">No library roots yet</h2>
				<p className="text-base-content/70 max-w-md">
					Garnet indexes files where they already live — point it at a folder and
					it will catalog what's inside without moving anything.
				</p>
				<button type="button" className="btn btn-primary mt-4" onClick={onAdd}>
					<HiFolderPlus className="size-4" />
					Add a folder
				</button>
			</div>
		</div>
	);
}

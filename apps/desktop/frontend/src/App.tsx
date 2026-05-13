// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
	HiFolderPlus,
	HiArrowPath,
	HiTrash,
	HiFolderOpen,
} from "react-icons/hi2";
import { AssetsView } from "@/components/AssetsView";
import { useLibraryStore } from "@/stores/libraryStore";
import { useAssetsStore } from "@/stores/assetsStore";

export default function App() {
	const { roots, lastScan, loading, error, refresh, addRoot, removeRoot, scanRoot } =
		useLibraryStore();
	const { rootId: openRootId, openRoot, refresh: refreshAssets } = useAssetsStore();

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const openRoot$ = roots.find((r) => r.id === openRootId) ?? null;

	async function pickAndAddRoot() {
		const selected = await open({ directory: true, multiple: false });
		if (typeof selected === "string") {
			await addRoot(selected);
		}
	}

	async function scanAndRefresh(id: number) {
		await scanRoot(id);
		if (openRootId === id) {
			await refreshAssets();
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
				{!openRoot$ && (
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
				)}
			</header>

			<main className="flex-1 p-6 max-w-5xl w-full mx-auto">
				{openRoot$ ? (
					<AssetsView root={openRoot$} />
				) : (
					<RootsView
						roots={roots}
						loading={loading}
						error={error}
						lastScan={lastScan}
						onAdd={pickAndAddRoot}
						onOpen={openRoot}
						onScan={scanAndRefresh}
						onRemove={removeRoot}
					/>
				)}
			</main>

			<footer className="text-center text-xs text-base-content/50 p-3 border-t border-base-300">
				Phase 1 — base toolkit. Modules disabled.
			</footer>
		</div>
	);
}

type RootsViewProps = {
	roots: ReturnType<typeof useLibraryStore.getState>["roots"];
	loading: boolean;
	error: string | null;
	lastScan: ReturnType<typeof useLibraryStore.getState>["lastScan"];
	onAdd: () => void;
	onOpen: (id: number) => void;
	onScan: (id: number) => void;
	onRemove: (id: number) => void;
};

function RootsView({
	roots,
	loading,
	error,
	lastScan,
	onAdd,
	onOpen,
	onScan,
	onRemove,
}: RootsViewProps) {
	if (loading && roots.length === 0) {
		return <div className="text-base-content/60">Loading…</div>;
	}
	if (roots.length === 0) {
		return <EmptyState onAdd={onAdd} />;
	}
	return (
		<div className="flex flex-col gap-3">
			<h2 className="text-lg font-medium">Library roots</h2>
			{error && (
				<div className="alert alert-error">
					<span>{error}</span>
				</div>
			)}
			{roots.map((root) => (
				<div key={root.id} className="card bg-base-100 border border-base-300">
					<div className="card-body p-4 flex-row items-center gap-3">
						<div className="flex-1 min-w-0">
							<div className="font-mono text-sm truncate">{root.path}</div>
							<div className="text-xs text-base-content/60">
								added {new Date(root.added_at * 1000).toLocaleString()}
							</div>
						</div>
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={() => onOpen(root.id)}
						>
							<HiFolderOpen className="size-4" />
							Open
						</button>
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => onScan(root.id)}
						>
							<HiArrowPath className="size-4" />
							Scan
						</button>
						<button
							type="button"
							className="btn btn-sm btn-ghost text-error"
							onClick={() => onRemove(root.id)}
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
						{lastScan.files_skipped} skipped (of {lastScan.files_seen} seen).
					</span>
				</div>
			)}
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

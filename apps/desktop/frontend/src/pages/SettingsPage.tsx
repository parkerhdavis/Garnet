// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HiFolderPlus, HiArrowPath, HiTrash } from "react-icons/hi2";
import { useLibraryStore } from "@/stores/libraryStore";

export function SettingsPage() {
	const {
		roots,
		lastScan,
		loading,
		error,
		scansInProgress,
		refresh,
		addRoot,
		removeRoot,
		scanRoot,
	} = useLibraryStore();

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
		<div className="flex-1 overflow-auto">
			<div className="max-w-3xl mx-auto p-6">
				<div className="flex items-center justify-between mb-4">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
						<p className="text-sm text-base-content/60">
							Library roots and other preferences. Garnet never moves files — it
							just remembers where to look. Scans run in the background and the
							library updates automatically when they complete.
						</p>
					</div>
				</div>

				<section className="card bg-base-100 border border-base-300">
					<div className="card-body p-5">
						<div className="flex items-center justify-between">
							<h2 className="text-lg font-medium">Library roots</h2>
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={pickAndAddRoot}
							>
								<HiFolderPlus className="size-4" />
								Add folder
							</button>
						</div>

						{error && (
							<div className="alert alert-error mt-3 text-sm">
								<span>{error}</span>
							</div>
						)}

						{loading && roots.length === 0 ? (
							<div className="py-6 text-center text-base-content/60">Loading…</div>
						) : roots.length === 0 ? (
							<div className="py-6 text-center text-base-content/60">
								No library roots yet. Add a folder above.
							</div>
						) : (
							<ul className="mt-3 divide-y divide-base-300">
								{roots.map((root) => {
									const scanning = scansInProgress.has(root.id);
									return (
										<li key={root.id} className="py-3 flex items-center gap-3">
											<div className="flex-1 min-w-0">
												<div className="font-mono text-sm truncate" title={root.path}>
													{root.path}
												</div>
												<div className="text-xs text-base-content/60">
													added {new Date(root.added_at * 1000).toLocaleString()}
													{scanning && <span className="text-warning ml-2">· scanning…</span>}
												</div>
											</div>
											<button
												type="button"
												className="btn btn-sm"
												onClick={() => scanRoot(root.id)}
												disabled={scanning}
												title={scanning ? "Scan already in progress" : "Re-scan this root"}
											>
												<HiArrowPath
													className={`size-4 ${scanning ? "animate-spin" : ""}`}
												/>
												{scanning ? "Scanning" : "Scan"}
											</button>
											<button
												type="button"
												className="btn btn-sm btn-ghost text-error"
												onClick={() => removeRoot(root.id)}
												aria-label="Remove root"
												disabled={scanning}
											>
												<HiTrash className="size-4" />
											</button>
										</li>
									);
								})}
							</ul>
						)}

						{lastScan && (
							<div className="alert alert-success mt-3 text-sm">
								<span>
									Last scan — {lastScan.files_inserted.toLocaleString()} new,{" "}
									{lastScan.files_updated.toLocaleString()} updated,{" "}
									{lastScan.files_renamed.toLocaleString()} renamed,{" "}
									{lastScan.files_deleted.toLocaleString()} deleted (of{" "}
									{lastScan.files_seen.toLocaleString()} seen).
								</span>
							</div>
						)}
					</div>
				</section>
			</div>
		</div>
	);
}

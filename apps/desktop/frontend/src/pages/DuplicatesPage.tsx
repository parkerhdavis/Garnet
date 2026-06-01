// SPDX-License-Identifier: AGPL-3.0-or-later
//! Library → Duplicates. Lists groups of byte-identical assets (same content
//! hash) so the user can reclaim space. Each group shows every copy with its
//! full path; trashing a copy moves it to Garnet's trash (recoverable) and
//! drops it from the group — when a group falls to a single copy it's no longer
//! a duplicate and disappears. A one-shot "Undo" restores the last trash.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openPath } from "@tauri-apps/plugin-opener";
import {
	HiArrowPath,
	HiArrowUturnLeft,
	HiDocumentDuplicate,
	HiFolderOpen,
	HiTrash,
} from "react-icons/hi2";
import type { Asset, DuplicateGroup, TrashResult } from "@/lib/tauri";
import { api } from "@/lib/tauri";
import {
	abbreviatePath,
	absPathFor,
	basename,
	dirname,
	formatSize,
} from "@/lib/paths";

export function DuplicatesPage() {
	const navigate = useNavigate();
	const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [lastTrash, setLastTrash] = useState<TrashResult | null>(null);

	const load = useCallback(() => {
		setLoading(true);
		setError(null);
		api
			.findDuplicates()
			.then((g) => setGroups(g))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, []);

	useEffect(load, [load]);

	async function trashOne(group: DuplicateGroup, asset: Asset) {
		let res: TrashResult;
		try {
			res = await api.trashAsset(asset.id);
		} catch (e) {
			setError(String(e));
			return;
		}
		setLastTrash(res);
		// Drop the copy locally; if a group falls below two copies it's no
		// longer a duplicate set.
		setGroups((prev) => {
			if (!prev) return prev;
			return prev
				.map((g) =>
					g.content_hash === group.content_hash
						? { ...g, assets: g.assets.filter((a) => a.id !== asset.id) }
						: g,
				)
				.filter((g) => g.assets.length > 1);
		});
	}

	async function undoLastTrash() {
		if (!lastTrash) return;
		try {
			await api.restoreFromTrash(
				lastTrash.trash_path,
				lastTrash.original_abs_path,
			);
		} catch (e) {
			setError(String(e));
			return;
		}
		setLastTrash(null);
		// The restored file re-indexes asynchronously via the watcher; reload to
		// pick it back up once it lands.
		load();
	}

	const totalReclaimable = (groups ?? []).reduce(
		(sum, g) => sum + (g.size ?? 0) * (g.assets.length - 1),
		0,
	);

	return (
		<div className="flex-1 min-h-0 overflow-auto p-6">
			<div className="max-w-3xl mx-auto">
				<header className="flex items-center gap-3 mb-6">
					<div className="size-10 rounded-lg bg-base-200 flex items-center justify-center">
						<HiDocumentDuplicate className="size-5 text-base-content/70" />
					</div>
					<div className="flex-1 min-w-0">
						<h1 className="text-xl font-semibold tracking-tight">Duplicates</h1>
						<p className="text-sm text-base-content/60">
							Byte-for-byte identical files across your library
							{groups && groups.length > 0 && totalReclaimable > 0 && (
								<>
									{" "}
									· up to{" "}
									<span className="font-medium text-base-content/80">
										{formatSize(totalReclaimable)}
									</span>{" "}
									reclaimable
								</>
							)}
							.
						</p>
					</div>
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={load}
						title="Rescan"
					>
						<HiArrowPath className="size-4" />
					</button>
				</header>

				{lastTrash && (
					<div className="mb-4 flex items-center gap-3 rounded-md border border-base-300 bg-base-100 px-3 py-2 text-sm">
						<span className="flex-1 min-w-0 truncate text-base-content/70">
							Trashed {basename(lastTrash.original_abs_path)}
						</span>
						<button
							type="button"
							className="btn btn-xs btn-ghost gap-1"
							onClick={undoLastTrash}
						>
							<HiArrowUturnLeft className="size-3.5" />
							Undo
						</button>
					</div>
				)}

				{error && (
					<div className="mb-4 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
						{error}
					</div>
				)}

				{loading && (
					<div className="py-16 text-center text-base-content/50">
						<span className="loading loading-spinner loading-md" />
					</div>
				)}

				{!loading && groups && groups.length === 0 && (
					<div className="py-16 text-center text-base-content/50">
						<HiDocumentDuplicate className="size-8 mx-auto mb-3 opacity-40" />
						<p className="text-sm">No duplicate files found.</p>
						<p className="text-xs mt-1 opacity-70">
							Every file in your library is unique.
						</p>
					</div>
				)}

				{!loading && groups && groups.length > 0 && (
					<div className="space-y-4">
						{groups.map((g) => (
							<DuplicateGroupCard
								key={g.content_hash}
								group={g}
								onOpen={(a) => navigate(`/asset/${a.id}`)}
								onTrash={(a) => trashOne(g, a)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function DuplicateGroupCard({
	group,
	onOpen,
	onTrash,
}: {
	group: DuplicateGroup;
	onOpen: (asset: Asset) => void;
	onTrash: (asset: Asset) => void;
}) {
	return (
		<div className="rounded-lg border border-base-300 bg-base-100 overflow-hidden">
			<div className="flex items-center gap-2 px-4 py-2 border-b border-base-200 bg-base-200/40">
				<span className="text-sm font-medium truncate">
					{basename(group.assets[0]?.relative_path ?? "")}
				</span>
				<span className="text-xs text-base-content/50 whitespace-nowrap">
					{group.assets.length} copies · {formatSize(group.size)} each
				</span>
			</div>
			<ul className="divide-y divide-base-200">
				{group.assets.map((a) => (
					<li
						key={a.id}
						className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-base-200/40"
					>
						<button
							type="button"
							className="flex-1 min-w-0 text-left"
							onClick={() => onOpen(a)}
							title={absPathFor(a)}
						>
							<span className="block truncate font-mono text-xs text-base-content/80">
								{abbreviatePath(absPathFor(a))}
							</span>
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-square"
							title="Open containing folder"
							onClick={() =>
								openPath(dirname(absPathFor(a))).catch(() => undefined)
							}
						>
							<HiFolderOpen className="size-4" />
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-square text-error hover:bg-error/15"
							title="Trash this copy"
							onClick={() => onTrash(a)}
						>
							<HiTrash className="size-4" />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

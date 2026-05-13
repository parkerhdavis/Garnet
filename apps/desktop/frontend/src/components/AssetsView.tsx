// SPDX-License-Identifier: AGPL-3.0-or-later
import { HiChevronLeft, HiArrowsUpDown, HiBarsArrowDown, HiBarsArrowUp } from "react-icons/hi2";
import type { AssetSortBy } from "@/lib/tauri";
import type { LibraryRoot } from "@/lib/tauri";
import { useAssetsStore, PAGE_SIZE } from "@/stores/assetsStore";

function formatSize(bytes: number | null): string {
	if (bytes === null) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let n = bytes;
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i += 1;
	}
	return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatTime(unix: number | null): string {
	if (unix === null) return "—";
	return new Date(unix * 1000).toLocaleString();
}

type Props = {
	root: LibraryRoot;
};

export function AssetsView({ root }: Props) {
	const {
		assets,
		total,
		formats,
		page,
		sortBy,
		sortDir,
		formatFilter,
		loading,
		error,
		close,
		setPage,
		setSort,
		setFormatFilter,
	} = useAssetsStore();

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const pageStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
	const pageEnd = Math.min(total, (page + 1) * PAGE_SIZE);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3">
				<button type="button" className="btn btn-sm btn-ghost" onClick={close}>
					<HiChevronLeft className="size-4" />
					Back
				</button>
				<div className="min-w-0 flex-1">
					<div className="font-mono text-sm truncate">{root.path}</div>
					<div className="text-xs text-base-content/60">
						{total.toLocaleString()} asset{total === 1 ? "" : "s"} indexed
					</div>
				</div>
				<select
					className="select select-sm select-bordered"
					value={formatFilter ?? ""}
					onChange={(e) =>
						setFormatFilter(e.target.value === "" ? null : e.target.value)
					}
					aria-label="Filter by format"
				>
					<option value="">All formats</option>
					{formats.map((f) => (
						<option key={f.format ?? "__null__"} value={f.format ?? ""}>
							{f.format ?? "(no extension)"} · {f.count.toLocaleString()}
						</option>
					))}
				</select>
			</div>

			{error && (
				<div className="alert alert-error">
					<span>{error}</span>
				</div>
			)}

			<div className="card bg-base-100 border border-base-300 overflow-hidden">
				<div className="overflow-x-auto">
					<table className="table table-sm table-zebra">
						<thead>
							<tr>
								<SortHeader by="path" current={sortBy} dir={sortDir} onClick={setSort}>
									Path
								</SortHeader>
								<SortHeader by="format" current={sortBy} dir={sortDir} onClick={setSort}>
									Format
								</SortHeader>
								<SortHeader by="size" current={sortBy} dir={sortDir} onClick={setSort}>
									Size
								</SortHeader>
								<SortHeader by="mtime" current={sortBy} dir={sortDir} onClick={setSort}>
									Modified
								</SortHeader>
							</tr>
						</thead>
						<tbody>
							{loading && assets.length === 0 ? (
								<tr>
									<td colSpan={4} className="text-center text-base-content/60 py-8">
										Loading…
									</td>
								</tr>
							) : assets.length === 0 ? (
								<tr>
									<td colSpan={4} className="text-center text-base-content/60 py-8">
										{total === 0
											? "No assets in this root yet — try a scan."
											: "No assets match the current filter."}
									</td>
								</tr>
							) : (
								assets.map((a) => (
									<tr key={a.id}>
										<td className="font-mono text-xs truncate max-w-md">
											{a.relative_path}
										</td>
										<td>
											{a.format ? (
												<span className="badge badge-sm badge-ghost">{a.format}</span>
											) : (
												<span className="text-base-content/40">—</span>
											)}
										</td>
										<td className="tabular-nums">{formatSize(a.size)}</td>
										<td className="text-xs text-base-content/70">
											{formatTime(a.mtime)}
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>

			{total > PAGE_SIZE && (
				<div className="flex items-center justify-between">
					<div className="text-sm text-base-content/60">
						{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of{" "}
						{total.toLocaleString()}
					</div>
					<div className="join">
						<button
							type="button"
							className="btn btn-sm join-item"
							disabled={page === 0}
							onClick={() => setPage(page - 1)}
						>
							Prev
						</button>
						<button type="button" className="btn btn-sm join-item pointer-events-none">
							{page + 1} / {totalPages}
						</button>
						<button
							type="button"
							className="btn btn-sm join-item"
							disabled={page + 1 >= totalPages}
							onClick={() => setPage(page + 1)}
						>
							Next
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function SortHeader({
	by,
	current,
	dir,
	onClick,
	children,
}: {
	by: AssetSortBy;
	current: AssetSortBy;
	dir: "asc" | "desc";
	onClick: (by: AssetSortBy) => void;
	children: React.ReactNode;
}) {
	const active = by === current;
	const Icon = !active ? HiArrowsUpDown : dir === "asc" ? HiBarsArrowUp : HiBarsArrowDown;
	return (
		<th>
			<button
				type="button"
				className={`flex items-center gap-1 hover:text-primary ${active ? "text-primary" : ""}`}
				onClick={() => onClick(by)}
			>
				{children}
				<Icon className="size-3.5" />
			</button>
		</th>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import { HiArrowsUpDown, HiBarsArrowDown, HiBarsArrowUp } from "react-icons/hi2";
import type { Asset, AssetSortBy, SortDir } from "@/lib/tauri";
import { abbreviatePath, formatSize, formatTime } from "@/lib/paths";

type Props = {
	assets: Asset[];
	sortBy: AssetSortBy;
	sortDir: SortDir;
	selectedId: number | null;
	onSort: (by: AssetSortBy) => void;
	onSelect: (id: number | null) => void;
	onOpen: (asset: Asset) => void;
};

export function AssetList({
	assets,
	sortBy,
	sortDir,
	selectedId,
	onSort,
	onSelect,
	onOpen,
}: Props) {
	return (
		<div className="p-6">
			<div className="card bg-base-100 border border-base-300 overflow-hidden">
				<div className="overflow-x-auto">
					<table className="table table-sm table-zebra">
						<thead>
							<tr>
								<SortHeader by="path" current={sortBy} dir={sortDir} onClick={onSort}>
									Path
								</SortHeader>
								<SortHeader by="root" current={sortBy} dir={sortDir} onClick={onSort}>
									Source
								</SortHeader>
								<SortHeader by="format" current={sortBy} dir={sortDir} onClick={onSort}>
									Format
								</SortHeader>
								<SortHeader by="size" current={sortBy} dir={sortDir} onClick={onSort}>
									Size
								</SortHeader>
								<SortHeader by="mtime" current={sortBy} dir={sortDir} onClick={onSort}>
									Modified
								</SortHeader>
							</tr>
						</thead>
						<tbody>
							{assets.map((a) => {
								const selected = a.id === selectedId;
								return (
									<tr
										key={a.id}
										className={`cursor-pointer ${selected ? "bg-primary/10" : ""}`}
										onClick={() => onSelect(a.id === selectedId ? null : a.id)}
										onDoubleClick={() => onOpen(a)}
									>
										<td
											className="font-mono text-xs truncate max-w-md"
											title={a.relative_path}
										>
											{a.relative_path}
										</td>
										<td
											className="text-xs text-base-content/70 max-w-[180px] truncate"
											title={a.root_path}
										>
											{abbreviatePath(a.root_path)}
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
								);
							})}
						</tbody>
					</table>
				</div>
			</div>
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
	dir: SortDir;
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

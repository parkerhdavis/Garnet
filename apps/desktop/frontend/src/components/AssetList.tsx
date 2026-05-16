// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo } from "react";
import { HiArrowsUpDown, HiBarsArrowDown, HiBarsArrowUp } from "react-icons/hi2";
import type { Asset, AssetSortBy, SortDir } from "@/lib/tauri";
import { openContextMenu } from "@/components/ContextMenu";
import { buildAssetContextMenu } from "@/lib/assetContextMenu";
import { abbreviatePath, formatSize, formatTime } from "@/lib/paths";
import { useIsSelected, useSelectionStore } from "@/stores/selectionStore";

type Props = {
	assets: Asset[];
	sortBy: AssetSortBy;
	sortDir: SortDir;
	onSort: (by: AssetSortBy) => void;
	onOpen: (asset: Asset) => void;
};

export function AssetList({ assets, sortBy, sortDir, onSort, onOpen }: Props) {
	const orderedIds = useMemo(() => assets.map((a) => a.id), [assets]);
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
							{assets.map((a) => (
								<AssetRow
									key={a.id}
									asset={a}
									orderedIds={orderedIds}
									onOpen={onOpen}
								/>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}

function AssetRow({
	asset,
	orderedIds,
	onOpen,
}: {
	asset: Asset;
	orderedIds: number[];
	onOpen: (asset: Asset) => void;
}) {
	const selected = useIsSelected(asset.id);

	const handleClick = (e: React.MouseEvent) => {
		const sel = useSelectionStore.getState();
		if (e.shiftKey) {
			sel.selectRange(asset.id, orderedIds);
		} else if (e.ctrlKey || e.metaKey) {
			sel.toggle(asset.id);
		} else {
			sel.replace(asset.id);
		}
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		const sel = useSelectionStore.getState();
		if (!sel.ids.has(asset.id)) sel.replace(asset.id);
		openContextMenu(e, buildAssetContextMenu(asset));
	};

	return (
		<tr
			className={`cursor-pointer ${selected ? "bg-primary/10" : "hover:bg-base-200"}`}
			aria-selected={selected}
			onClick={handleClick}
			onDoubleClick={() => onOpen(asset)}
			onContextMenu={handleContextMenu}
		>
			<td
				className="font-mono text-xs truncate max-w-md"
				title={asset.relative_path}
			>
				{asset.relative_path}
			</td>
			<td
				className="text-xs text-base-content/70 max-w-[180px] truncate"
				title={asset.root_path}
			>
				{abbreviatePath(asset.root_path)}
			</td>
			<td>
				{asset.format ? (
					<span className="badge badge-sm badge-ghost">{asset.format}</span>
				) : (
					<span className="text-base-content/40">—</span>
				)}
			</td>
			<td className="tabular-nums">{formatSize(asset.size)}</td>
			<td className="text-xs text-base-content/70">{formatTime(asset.mtime)}</td>
		</tr>
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

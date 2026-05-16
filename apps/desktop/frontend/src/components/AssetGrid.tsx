// SPDX-License-Identifier: AGPL-3.0-or-later
import { Fragment, useMemo } from "react";
import { motion } from "motion/react";
import type { Asset } from "@/lib/tauri";
import { AssetThumbnail } from "@/components/AssetThumbnail";
import { openContextMenu } from "@/components/ContextMenu";
import { buildAssetContextMenu } from "@/lib/assetContextMenu";
import { groupOf } from "@/lib/grouping";
import { basename, formatSize } from "@/lib/paths";
import { useAssetsStore } from "@/stores/assetsStore";
import { useIsSelected, useSelectionStore } from "@/stores/selectionStore";

type Props = {
	assets: Asset[];
	onOpen: (asset: Asset) => void;
};

// Stagger tile entry by a small per-index delay so the grid feels like it's
// settling in rather than appearing all at once. Capped so a 60-tile page
// finishes within ~500ms even at full count.
const STAGGER_PER_INDEX = 0.012;
const STAGGER_MAX = 0.5;

export function AssetGrid({ assets, onOpen }: Props) {
	// Range-select needs an ordered list of currently-visible ids. Memoize so
	// each tile's click handler can reference a stable array without
	// re-computing per click.
	const orderedIds = useMemo(() => assets.map((a) => a.id), [assets]);
	const groupBy = useAssetsStore((s) => s.groupBy);

	let prevKey: string | null = null;

	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-4">
			{assets.map((asset, i) => {
				const delay = Math.min(i * STAGGER_PER_INDEX, STAGGER_MAX);
				const group = groupOf(asset, groupBy);
				const showHeader = group !== null && group.key !== prevKey;
				if (group) prevKey = group.key;
				return (
					<Fragment key={asset.id}>
						{showHeader && group && (
							<GroupHeader label={group.label} firstInPage={i === 0} />
						)}
						<AssetTile
							asset={asset}
							orderedIds={orderedIds}
							delay={delay}
							onOpen={onOpen}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}

function GroupHeader({ label, firstInPage }: { label: string; firstInPage: boolean }) {
	return (
		<div className={`col-span-full ${firstInPage ? "" : "mt-3"}`}>
			<div className="flex items-center gap-3">
				<h2 className="text-sm font-semibold text-base-content/80 whitespace-nowrap">
					{label}
				</h2>
				<div className="flex-1 border-t border-base-300" />
			</div>
		</div>
	);
}

function AssetTile({
	asset,
	orderedIds,
	delay,
	onOpen,
}: {
	asset: Asset;
	orderedIds: number[];
	delay: number;
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

	const handleDoubleClick = () => {
		onOpen(asset);
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		// If the user right-clicks a tile that isn't already in the
		// selection, replace selection with just that tile before showing
		// the menu — matches Finder/Files convention so the menu always
		// operates on a state the user can see.
		const sel = useSelectionStore.getState();
		if (!sel.ids.has(asset.id)) sel.replace(asset.id);
		openContextMenu(e, buildAssetContextMenu(asset));
	};

	return (
		<motion.button
			type="button"
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			onContextMenu={handleContextMenu}
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.28, delay, ease: [0.16, 1, 0.3, 1] }}
			whileHover={{ y: -2 }}
			aria-pressed={selected}
			className={`text-left card card-compact bg-base-100 border transition-colors hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/50 ${
				selected
					? "border-primary ring-2 ring-primary/40 bg-primary/5"
					: "border-base-300 hover:border-primary/60"
			}`}
		>
			<figure className="aspect-square bg-base-200 overflow-hidden">
				<AssetThumbnail asset={asset} liveOnHover />
			</figure>
			<div className="card-body py-2 px-2.5">
				<div
					className="text-xs font-medium truncate"
					title={asset.relative_path}
				>
					{basename(asset.relative_path)}
				</div>
				<div className="flex items-center justify-between text-[10px] text-base-content/60">
					<span className="uppercase tracking-wide">{asset.format ?? "—"}</span>
					<span className="tabular-nums">{formatSize(asset.size)}</span>
				</div>
			</div>
		</motion.button>
	);
}

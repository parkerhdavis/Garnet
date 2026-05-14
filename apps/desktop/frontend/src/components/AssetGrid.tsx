// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion } from "motion/react";
import type { Asset } from "@/lib/tauri";
import { AssetThumbnail } from "@/components/AssetThumbnail";
import { openContextMenu } from "@/components/ContextMenu";
import { buildAssetContextMenu } from "@/lib/assetContextMenu";
import { basename, formatSize } from "@/lib/paths";

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
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-4">
			{assets.map((asset, i) => {
				const delay = Math.min(i * STAGGER_PER_INDEX, STAGGER_MAX);
				return (
					<motion.button
						type="button"
						key={asset.id}
						onClick={() => onOpen(asset)}
						onContextMenu={(e) =>
							openContextMenu(e, buildAssetContextMenu(asset))
						}
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.28, delay, ease: [0.16, 1, 0.3, 1] }}
						whileHover={{ y: -2 }}
						className="text-left card card-compact bg-base-100 border border-base-300 hover:border-primary/60 hover:shadow-md transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/50"
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
								<span className="uppercase tracking-wide">
									{asset.format ?? "—"}
								</span>
								<span className="tabular-nums">{formatSize(asset.size)}</span>
							</div>
						</div>
					</motion.button>
				);
			})}
		</div>
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Asset } from "@/lib/tauri";
import { AssetThumbnail } from "@/components/AssetThumbnail";
import { basename, formatSize } from "@/lib/paths";

type Props = {
	assets: Asset[];
	selectedId: number | null;
	onSelect: (id: number | null) => void;
	onOpen: (asset: Asset) => void;
};

export function AssetGrid({ assets, selectedId, onSelect, onOpen }: Props) {
	return (
		<div
			className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-6"
			onClick={(e) => {
				// Background click deselects.
				if (e.target === e.currentTarget) onSelect(null);
			}}
		>
			{assets.map((asset) => {
				const selected = asset.id === selectedId;
				return (
					<button
						type="button"
						key={asset.id}
						onClick={() =>
							onSelect(asset.id === selectedId ? null : asset.id)
						}
						onDoubleClick={() => onOpen(asset)}
						className={`text-left card card-compact bg-base-100 border transition-colors focus:outline-none ${
							selected
								? "border-primary ring-2 ring-primary/50"
								: "border-base-300 hover:border-primary/60"
						}`}
					>
						<figure className="aspect-square bg-base-200 overflow-hidden">
							<AssetThumbnail asset={asset} liveOnHover />
						</figure>
						<div className="card-body py-2 px-3">
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
					</button>
				);
			})}
		</div>
	);
}

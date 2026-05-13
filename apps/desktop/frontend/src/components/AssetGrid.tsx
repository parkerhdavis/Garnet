// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Asset } from "@/lib/tauri";
import { AssetThumbnail } from "@/components/AssetThumbnail";

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

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}

type Props = { assets: Asset[] };

export function AssetGrid({ assets }: Props) {
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-6">
			{assets.map((asset) => (
				<div
					key={asset.id}
					className="card card-compact bg-base-100 border border-base-300 hover:border-primary/60 transition-colors"
				>
					<figure className="aspect-square bg-base-200 overflow-hidden">
						<AssetThumbnail asset={asset} className="rounded-t" />
					</figure>
					<div className="card-body py-2 px-3">
						<div className="text-xs font-medium truncate" title={asset.relative_path}>
							{basename(asset.relative_path)}
						</div>
						<div className="flex items-center justify-between text-[10px] text-base-content/60">
							<span className="uppercase tracking-wide">{asset.format ?? "—"}</span>
							<span className="tabular-nums">{formatSize(asset.size)}</span>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

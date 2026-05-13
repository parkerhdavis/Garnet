// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HiArrowTopRightOnSquare, HiXMark } from "react-icons/hi2";
import { api, type Asset, type AssetMetadata } from "@/lib/tauri";
import { AssetThumbnail } from "@/components/AssetThumbnail";
import { TagEditor } from "@/components/TagEditor";
import {
	absPathFor,
	abbreviatePath,
	basename,
	formatSize,
	formatTime,
} from "@/lib/paths";

type Props = {
	asset: Asset;
	onClose: () => void;
};

export function DetailsSidebar({ asset, onClose }: Props) {
	const [metadata, setMetadata] = useState<AssetMetadata[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		api.listAssetMetadata(asset.id)
			.then((m) => {
				if (!cancelled) setMetadata(m);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [asset.id]);

	return (
		<aside className="w-80 shrink-0 bg-base-100 border-l border-base-300 overflow-y-auto flex flex-col">
			<div className="flex items-center justify-between p-3 border-b border-base-300 sticky top-0 bg-base-100 z-10">
				<div className="text-sm font-medium truncate" title={asset.relative_path}>
					{basename(asset.relative_path)}
				</div>
				<button
					type="button"
					className="btn btn-xs btn-ghost"
					onClick={onClose}
					aria-label="Close details"
				>
					<HiXMark className="size-4" />
				</button>
			</div>

			<div className="aspect-square bg-base-200 border-b border-base-300 flex items-center justify-center">
				<AssetThumbnail asset={asset} size={512} />
			</div>

			<div className="p-3 flex items-center justify-between border-b border-base-300">
				<Link
					to={`/asset/${asset.id}`}
					className="btn btn-sm btn-primary w-full"
					title="Open detail page"
				>
					<HiArrowTopRightOnSquare className="size-4" />
					Open
				</Link>
			</div>

			<dl className="p-3 text-xs space-y-2">
				<KV label="Path" value={asset.relative_path} mono />
				<KV label="Source" value={abbreviatePath(asset.root_path)} mono />
				<KV label="Format" value={asset.format ?? "—"} />
				<KV label="Size" value={formatSize(asset.size)} />
				<KV label="Modified" value={formatTime(asset.mtime)} />
			</dl>

			<div className="p-3 border-t border-base-300">
				<div className="text-xs uppercase tracking-wide text-base-content/60 mb-2">
					Tags
				</div>
				<TagEditor assetId={asset.id} />
			</div>

			<div className="p-3 border-t border-base-300 flex-1">
				<div className="text-xs uppercase tracking-wide text-base-content/60 mb-2">
					Metadata
				</div>
				{loading ? (
					<div className="text-xs text-base-content/50">Loading…</div>
				) : metadata.length === 0 ? (
					<div className="text-xs text-base-content/50">
						No metadata extracted.
					</div>
				) : (
					<dl className="text-xs space-y-1">
						{metadata.map((m) => (
							<div key={`${m.key}-${m.value}`} className="grid grid-cols-[1fr_auto] gap-2">
								<dt className="text-base-content/60 font-mono truncate" title={m.key}>
									{m.key}
								</dt>
								<dd className="font-mono truncate" title={m.value}>
									{m.value}
								</dd>
							</div>
						))}
					</dl>
				)}
			</div>

			<div className="p-3 border-t border-base-300 text-[10px] text-base-content/40 font-mono break-all">
				{absPathFor(asset)}
			</div>
		</aside>
	);
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="grid grid-cols-[80px_1fr] gap-2">
			<dt className="text-base-content/60">{label}</dt>
			<dd className={`truncate ${mono ? "font-mono" : ""}`} title={value}>
				{value}
			</dd>
		</div>
	);
}
